// Prettier-formatted code (printWidth: 80)
// Note: Install additional deps: npm i pytesseract child_process

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import OpenAI from 'openai';
import { detectMobileFormFields } from './mobileFieldDetector.js';
import { createEnhancedVisualization } from './enhancedVisualizationSharp.js';
import { detectFormFields, createFieldDetectionVisualization } from './smartFieldDetector.js';
import { detectFormFieldsSimple, createSimpleVisualization } from './simpleFieldDetector.js';
import { detectFieldsByContrast, createEdgeVisualization } from './contrastFieldDetector.js';
import { exec } from 'child_process'; // CHANGE: Added for OCR via Tesseract
import util from 'util'; // CHANGE: For promisifying exec

const execAsync = util.promisify(exec); // CHANGE: Promisify for async OCR

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create necessary directories
const uploadsDir = path.join(__dirname, 'uploads');
const reportsDir = path.join(__dirname, 'reports');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// Debug endpoint - show what we're detecting
app.post('/debug-detection', upload.single('screenshot'), async (req, res) => {
  try {
    const screenshotPath = req.file.path;
    const image = await sharp(screenshotPath);
    const metadata = await image.metadata();
    
    // Get a sample of the image to understand what we're looking at
    const { data, info } = await image
      .resize({ width: 100 }) // Small sample
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    // Find brightness distribution
    const brightnessMap = [];
    for (let i = 0; i < data.length; i += info.channels) {
      const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
      brightnessMap.push(Math.round(brightness));
    }
    
    const brightPixels = brightnessMap.filter(b => b > 200).length;
    const darkPixels = brightnessMap.filter(b => b < 100).length;
    
    res.json({
      metadata: metadata,
      analysis: {
        channels: info.channels,
        sampleSize: brightnessMap.length,
        brightPixels: brightPixels,
        darkPixels: darkPixels,
        brightPercentage: (brightPixels / brightnessMap.length * 100).toFixed(2) + '%',
        darkPercentage: (darkPixels / brightnessMap.length * 100).toFixed(2) + '%'
      }
    });
    
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Smart field detection endpoint - with AI fallback
app.post('/detect-fields', upload.single('screenshot'), async (req, res) => {
  try {
    const screenshotPath = req.file.path;
    const apiKey = req.body.openaiApiKey;
    
    // If API key provided, use AI detection
    if (apiKey) {
      console.log('Using AI-powered field detection');
      const aiResult = await detectFieldsWithAI(screenshotPath, apiKey);
      return res.json(aiResult);
    }
    
    // Otherwise, try contrast-based detection
    console.log('Starting contrast-based field detection for:', screenshotPath);
    const detectedFields = await detectFieldsByContrast(screenshotPath);
    
    // Create visualization
    const timestamp = Date.now();
    const visualizationPath = path.join(uploadsDir, `field-detection-${timestamp}.png`);
    await createEdgeVisualization(screenshotPath, detectedFields, visualizationPath);
    
    console.log('Detection complete:', {
      fields: detectedFields.fields.length,
      buttons: detectedFields.buttons.length,
      total: detectedFields.total
    });
    
    // If Figma JSON provided, compare
    let comparison = null;
    if (req.body.figmaJSON) {
      const figmaData = JSON.parse(req.body.figmaJSON);
      const figmaProperties = extractFigmaProperties(figmaData);
      
      if (figmaProperties.formFields && figmaProperties.formFields.length > 0) {
        // Simple comparison
        comparison = {
          figmaFieldCount: figmaProperties.formFields.length,
          detectedFieldCount: detectedFields.total,
          match: Math.abs(figmaProperties.formFields.length - detectedFields.total) <= 2 ? 'good' : 'mismatch'
        };
      }
    }
    
    res.json({
      success: true,
      detected: detectedFields,
      visualization: `/uploads/${path.basename(visualizationPath)}`,
      comparison: comparison,
      summary: {
        inputFields: detectedFields.fields ? detectedFields.fields.length : 0,
        buttons: detectedFields.buttons ? detectedFields.buttons.length : 0,
        labels: detectedFields.labels ? detectedFields.labels.length : 0,
        total: detectedFields.total || 0
      }
    });
    
  } catch (error) {
    console.error('Field detection error:', error);
    res.status(500).json({ 
      error: 'Field detection failed', 
      message: error.message 
    });
  }
});

// Mobile UI field detection endpoint
app.post('/analyze-mobile', upload.single('screenshot'), async (req, res) => {
  try {
    const screenshotPath = req.file.path;
    const { figmaDesign, platform = 'auto', apiKey } = req.body;
    
    // Parse Figma design if provided
    let figmaProperties = null;
    if (figmaDesign) {
      figmaProperties = extractFigmaProperties(JSON.parse(figmaDesign));
    }
    
    // Detect fields in mobile screenshot
    const detectionResult = await detectMobileFormFields(screenshotPath, {
      platform,
      ocrEnabled: true
    });
    
    // Compare with Figma if available
    let comparison = null;
    if (figmaProperties && figmaProperties.formFields) {
      comparison = compareFormFields(figmaProperties, {
        aiElements: detectionResult.fields
      });
    }
    
    // Create enhanced visualization
    const visualizations = await createEnhancedVisualization(
      screenshotPath,
      figmaProperties?.formFields || [],
      detectionResult.fields,
      { formFieldMismatches: comparison || [] },
      {
        outputDir: uploadsDir,
        showLabels: true,
        showConfidence: true,
        showMismatches: true,
        sideBySide: true
      }
    );
    
    // Prepare response
    const report = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      platform: detectionResult.metadata.platform,
      screenSize: detectionResult.metadata.screenSize,
      detectedFields: detectionResult.fields,
      figmaFields: figmaProperties?.formFields || [],
      comparison: comparison || { formFieldMismatches: [] },
      visualizations: {
        overlay: `/uploads/${path.basename(visualizations.overlay)}`,
        annotated: `/uploads/${path.basename(visualizations.annotated)}`,
        sideBySide: visualizations.sideBySide ? `/uploads/${path.basename(visualizations.sideBySide)}` : null
      },
      statistics: {
        totalDetected: detectionResult.fields.length,
        totalExpected: figmaProperties?.formFields?.length || 0,
        platform: detectionResult.metadata.platform
      }
    };
    
    // Save report
    const reportPath = path.join(reportsDir, `mobile-report-${report.id}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    
    res.json(report);
    
  } catch (error) {
    console.error('Mobile analysis error:', error);
    res.status(500).json({ 
      error: 'Mobile analysis failed', 
      message: error.message 
    });
  }
});

// Figma API proxy endpoint
app.post('/figma/fetch', async (req, res) => {
  try {
    const { fileKey, nodeId, token } = req.body;
    
    if (!fileKey || !token) {
      return res.status(400).json({ error: 'Missing fileKey or token' });
    }
    
    let url = `https://api.figma.com/v1/files/${fileKey}`;
    
    if (nodeId) {
      // Ensure node ID uses colon format for API
      const apiNodeId = nodeId.replace('-', ':');
      url += `/nodes?ids=${apiNodeId}`;
    }
    
    const response = await fetch(url, {
      headers: {
        'X-Figma-Token': token
      }
    });
    
    if (!response.ok) {
      const error = await response.json();
      return res.status(response.status).json({ error: error.err || 'Failed to fetch Figma design' });
    }
    
    const data = await response.json();
    
    // Log for debugging
    console.log('Figma API response structure:', Object.keys(data));
    
    if (nodeId && data.nodes) {
      // Try both node ID formats
      const apiNodeId = nodeId.replace('-', ':');
      const node = data.nodes[nodeId] || data.nodes[apiNodeId];
      
      console.log('Looking for node:', nodeId, 'or', apiNodeId);
      console.log('Available nodes:', Object.keys(data.nodes));
      
      if (node) {
        if (node.document) {
          return res.json({ design: node.document });
        } else {
          // Return the node itself if it doesn't have a document property
          return res.json({ design: node });
        }
      }
    } else if (data.document) {
      // Return entire document
      return res.json({ design: data.document });
    }
    
    // If we have nodes but couldn't find the specific one, return the first node
    if (data.nodes && Object.keys(data.nodes).length > 0) {
      const firstNodeKey = Object.keys(data.nodes)[0];
      const firstNode = data.nodes[firstNodeKey];
      console.log('Returning first node:', firstNodeKey);
      return res.json({ design: firstNode.document || firstNode });
    }
    
    res.status(404).json({ error: 'No design data found', debug: { hasNodes: !!data.nodes, nodeCount: data.nodes ? Object.keys(data.nodes).length : 0 } });
    
  } catch (error) {
    console.error('Figma proxy error:', error);
    res.status(500).json({ error: 'Server error while fetching Figma design' });
  }
});

// New analysis endpoint for JSON vs screenshot
app.post('/analyze', upload.fields([
  { name: 'screenshot', maxCount: 1 }
]), async (req, res) => {
  try {
    const figmaJSON = JSON.parse(req.body.figmaJSON);
    const screenshotPath = req.files.screenshot[0].path;
    
    // Extract properties from Figma JSON
    const figmaProperties = extractFigmaProperties(figmaJSON);
    
    // Analyze screenshot
    const detectedProperties = await analyzeScreenshot(screenshotPath);
    
    // Compare properties
    const comparison = compareProperties(figmaProperties, detectedProperties);
    
    // Create spacing overlay visualization
    const spacingOverlay = await createSpacingOverlay(screenshotPath, detectedProperties, comparison, Date.now());
    
    // Generate report
    const reportId = Date.now();
    const report = {
      id: reportId,
      timestamp: new Date().toISOString(),
      figmaProperties: figmaProperties,
      detectedProperties: detectedProperties,
      accuracy: comparison.accuracy,
      totalMismatches: comparison.mismatches.length,
      colorMismatches: comparison.colorMismatches,
      propertyMismatches: comparison.mismatches,
      spacingMismatches: comparison.spacingMismatches || [],
      textMismatches: comparison.textMismatches || [],
      sizeMismatches: comparison.sizeMismatches || [],
      visualizations: {
        spacingOverlay: spacingOverlay,
        screenshotPath: `/uploads/${path.basename(screenshotPath)}`
      }
    };
    
    res.json(report);
    
  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: 'Analysis failed', message: error.message });
  }
});

// AI-powered analysis endpoint using OpenAI Vision
app.post('/analyze-with-ai', upload.fields([
  { name: 'screenshot', maxCount: 1 }
]), async (req, res) => {
  try {
    const figmaJSON = JSON.parse(req.body.figmaJSON);
    const screenshotPath = req.files.screenshot[0].path;
    const openaiApiKey = req.body.openaiApiKey;
    
    if (!openaiApiKey) {
      return res.status(400).json({ 
        error: 'OpenAI API key is required for AI analysis' 
      });
    }
    
    // CHANGE: Normalize scales before analysis (Step 1 from guide)
    const normalizedScreenshotPath = await normalizeScreenshotToFigma(screenshotPath, figmaJSON);
    
    // Extract properties from Figma JSON
    const figmaProperties = extractFigmaProperties(figmaJSON);
    
    // Perform standard computer vision analysis
    const detectedProperties = await analyzeScreenshot(normalizedScreenshotPath);
    
    // Perform AI-powered analysis
    const aiAnalysis = await analyzeWithOpenAI(normalizedScreenshotPath, figmaProperties, openaiApiKey);
    
    // Combine both analyses
    const enhancedDetectedProperties = combineAnalyses(detectedProperties, aiAnalysis);
    
    // Compare properties with enhanced comparison logic
    const comparison = comparePropertiesEnhanced(figmaProperties, enhancedDetectedProperties);
    
    // Create spacing overlay visualization
    const spacingOverlay = await createSpacingOverlay(normalizedScreenshotPath, detectedProperties, comparison, Date.now());
    
    // CHANGE: Generate structured report with suggestions (Step 5)
    const reportId = Date.now();
    const report = generateStructuredReport(reportId, figmaProperties, enhancedDetectedProperties, aiAnalysis, comparison, spacingOverlay, normalizedScreenshotPath);
    
    res.json(report);
    
  } catch (error) {
    console.error('AI Analysis error:', error);
    res.status(500).json({ 
      error: 'AI analysis failed', 
      message: error.message,
      fallback: 'You can still use the standard analysis without AI'
    });
  }
});

// CHANGE: New function to normalize screenshot to Figma dimensions (Step 1)
async function normalizeScreenshotToFigma(screenshotPath, figmaJSON) {
  console.log('Normalizing screenshot to Figma scale...'); // Witty log
  const figmaBounds = figmaJSON.document.absoluteBoundingBox || { width: 1920, height: 1080 }; // Fallback
  const metadata = await sharp(screenshotPath).metadata();
  
  if (metadata.width !== figmaBounds.width || metadata.height !== figmaBounds.height) {
    const normalizedPath = path.join(uploadsDir, `normalized-${Date.now()}.png`);
    await sharp(screenshotPath)
      .resize(figmaBounds.width, figmaBounds.height, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
      .toFile(normalizedPath);
    return normalizedPath;
  }
  return screenshotPath;
}

// CHANGE: Enhanced function to generate structured report (Step 5)
function generateStructuredReport(id, figma, detected, aiAnalysis, comparison, spacingOverlay, screenshotPath) {
  const score = comparison.accuracy;
  const suggestions = [];
  comparison.mismatches.forEach(m => {
    suggestions.push(`Fix ${m.property}: Change from ${m.actual} to ${m.expected}`);
  });

  return {
    id,
    timestamp: new Date().toISOString(),
    analysisType: 'AI_ENHANCED',
    figmaProperties: figma,
    detectedProperties: detected,
    aiAnalysis,
    accuracy: score,
    confidenceScore: aiAnalysis.confidence || 0.8,
    totalMismatches: comparison.mismatches.length,
    colorMismatches: comparison.colorMismatches,
    propertyMismatches: comparison.mismatches,
    spacingMismatches: comparison.spacingMismatches || [],
    textMismatches: comparison.textMismatches || [],
    sizeMismatches: comparison.sizeMismatches || [],
    layoutMismatches: comparison.layoutMismatches || [],
    formFieldMismatches: comparison.formFieldMismatches || [],
    formFields: {
      expected: figma.formFields || [],
      detected: detected.aiElements?.filter(el => 
        ['input', 'button', 'dropdown', 'checkbox', 'radio', 'textarea'].includes(el.type)
      ) || []
    },
    recommendations: suggestions, // CHANGE: Added suggestions
    insights: aiAnalysis.insights || [],
    visualizations: {
      spacingOverlay,
      screenshotPath: `/uploads/${path.basename(screenshotPath)}`
    },
    // CHANGE: Added Markdown-like summary
    summaryReport: `
## Comparison Report
- **Overall Accuracy**: ${score}%
- **Matches**: ${figma.elements.length - comparison.totalMismatches}/${figma.elements.length} elements.
- **Differences**:
  ${comparison.mismatches.map(m => `- ${m.property}: Expected ${m.expected}, Actual ${m.actual}`).join('\n  ')}
- **Suggestions**: ${suggestions.join(', ')}
    `
  };
}

// Analyze screenshot using OpenAI Vision API
async function analyzeWithOpenAI(screenshotPath, figmaProperties, apiKey) {
  try {
    const openai = new OpenAI({ apiKey: apiKey });
    
    // Convert image to base64
    const imageBuffer = fs.readFileSync(screenshotPath);
    const base64Image = imageBuffer.toString('base64');
    
    // Create detailed prompt for UI analysis
    const prompt = createUIAnalysisPrompt(figmaProperties);
    
    console.log('Sending image to OpenAI for analysis...');
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a UI/UX comparison tool that analyzes screenshots against design specifications. You MUST respond with ONLY a JSON object - no other text, no markdown, no explanations. Just the raw JSON starting with { and ending with }."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt + "\n\nREMEMBER: Output ONLY the JSON object. No other text."
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
                detail: "high"
              }
            }
          ]
        }
      ],
      max_tokens: 3000,
      temperature: 0.1 // Low temperature for more consistent analysis
    });
    
    const aiResponse = response.choices[0].message.content;
    
    console.log('AI Response received, length:', aiResponse.length);
    console.log('First 500 chars of response:', aiResponse.substring(0, 500));
    
    // Parse AI response into structured data
    const structuredAnalysis = parseAIResponse(aiResponse);
    
    return {
      rawResponse: aiResponse,
      ...structuredAnalysis,
      confidence: 0.85, // High confidence for GPT-4V
      analysisTimestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('OpenAI API error:', error);
    
    // Return a fallback analysis
    return {
      error: error.message,
      confidence: 0.0,
      elements: [],
      spacing: { issues: ['AI analysis failed'] },
      layout: { patterns: [], issues: ['AI analysis unavailable'] },
      recommendations: ['AI analysis failed - using computer vision only'],
      insights: ['OpenAI analysis could not be completed']
    };
  }
}

// CHANGE: Enhanced prompt with more focus on fields (Step 3)
function createUIAnalysisPrompt(figmaProperties) {
  // Prepare detailed Figma specifications for comparison
  const figmaColors = figmaProperties.colors.map(c => `${c.value} (${c.name || 'unnamed'})`).join(', ');
  const figmaTypography = figmaProperties.typography.map(t => 
    `${t.fontFamily} ${t.fontSize}px (${t.fontWeight || 'normal'})`
  ).join(', ') || 'No typography specified';
  
  const figmaDimensions = figmaProperties.dimensions ? 
    `Width: ${figmaProperties.dimensions.width}px, Height: ${figmaProperties.dimensions.height}px` : 
    'Not specified';
  
  const figmaSpacing = {
    padding: figmaProperties.spacing.padding || 'Not specified',
    margin: figmaProperties.spacing.margin || 'Not specified',
    gap: figmaProperties.spacing.gap || 'Not specified'
  };
  
  const figmaBorders = figmaProperties.borders || {};
  const figmaElements = figmaProperties.elements.map(el => ({
    type: el.type,
    name: el.name,
    position: el.properties.position,
    dimensions: { width: el.properties.position?.width, height: el.properties.position?.height }
  }));
  
  // CHANGE: Added detailed field specs for better comparison
  const figmaFields = figmaProperties.formFields ? figmaProperties.formFields.map(field => 
    `   - ${field.type}${field.subtype ? ' (' + field.subtype + ')' : ''}: "${field.name}"` +
    `${field.label ? ' with label "' + field.label.text + '"' : ''}` +
    `${field.placeholder ? ' placeholder "' + field.placeholder + '"' : ''}` +
    ` at (${field.properties.position?.x || 0}, ${field.properties.position?.y || 0})`
  ).join('\n') : 'No form fields specified';
  
  return `Analyze the provided screenshot and compare it against the Figma design specifications below. Focus especially on form fields: check text content, placeholders, labels, and positions.

FIGMA DESIGN SPECIFICATIONS TO COMPARE AGAINST:

1. COLORS:
   - Specified colors: ${figmaColors}
   - Total color palette size: ${figmaProperties.colors.length} colors

2. DIMENSIONS:
   - ${figmaDimensions}

3. SPACING:
   - Padding: ${JSON.stringify(figmaSpacing.padding)}
   - Margin: ${JSON.stringify(figmaSpacing.margin)}
   - Gap between elements: ${figmaSpacing.gap}px

4. TYPOGRAPHY:
   - Specified fonts: ${figmaTypography}
   - Total text styles: ${figmaProperties.typography.length}

5. LAYOUT:
   - Layout mode: ${figmaProperties.layout.mode || 'Not specified'}
   - Alignment: ${figmaProperties.layout.primaryAxisAlignItems || 'Not specified'}
   - Item spacing: ${figmaProperties.layout.itemSpacing || 'Not specified'}px

6. BORDERS & EFFECTS:
   - Border radius: ${figmaBorders.radius || 'Not specified'}
   - Border width: ${figmaBorders.strokeWeight || 'Not specified'}
   - Border color: ${figmaBorders.color || 'Not specified'}

7. ELEMENTS (${figmaProperties.elements.length} total):
${figmaElements.slice(0, 5).map(el => `   - ${el.type}: "${el.name}" at position (${el.position?.x || 0}, ${el.position?.y || 0}) with size ${el.dimensions.width}x${el.dimensions.height}`).join('\n')}
${figmaElements.length > 5 ? `   ... and ${figmaElements.length - 5} more elements` : ''}

8. FORM FIELDS (${figmaProperties.formFields?.length || 0} total):
${figmaFields}

TASK: Compare the screenshot against the specifications above. For fields, check text matches, positions (tolerance 5%), and presence.

Return a JSON object with this exact structure:
{
  "comparisonResults": {
    "overallMatch": 0-100,
    "summary": "Brief summary of how well the implementation matches the design"
  },
  "colorComparison": { /* ... same as before */ },
  "spacingComparison": { /* ... same as before */ },
  "dimensionComparison": { /* ... same as before */ },
  "elementComparison": { /* ... same as before */ },
  "typographyComparison": { /* ... same as before */ },
  "layoutComparison": { /* ... same as before */ },
  "borderComparison": { /* ... same as before */ },
  "formFieldComparison": {
    "figmaFields": [ /* array of expected fields */ ],
    "detectedFields": [ /* array of detected fields with text, position */ ],
    "missingFields": ["..."],
    "extraFields": ["..."],
    "deviations": ["Email field text is 'Enter' instead of 'Email address'"]
  },
  "criticalIssues": [ /* ... */ ],
  "recommendations": [ /* ... */ ],
  "confidence": 0.0-1.0
}

IMPORTANT INSTRUCTIONS: /* ... same as before */`;
}

// Parse AI response into structured data
function parseAIResponse(aiResponse) {
  try {
    // Log the raw response for debugging
    console.log('Raw AI Response:', aiResponse.substring(0, 200) + '...');
    
    // First try to parse as direct JSON
    try {
      const parsed = JSON.parse(aiResponse);
      console.log('Successfully parsed direct JSON response');
      return convertParsedResponse(parsed);
    } catch (e) {
      // If direct parse fails, try to extract JSON from the response
      console.log('Direct JSON parse failed, attempting to extract JSON...');
    }
    
    // Try to extract JSON from the response
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('Successfully extracted and parsed JSON from response');
      return convertParsedResponse(parsed);
    }
    
    // If we get here, the AI didn't return proper JSON
    console.error('AI did not return valid JSON. Response:', aiResponse);
    throw new Error('Invalid JSON response from AI');
    
  } catch (error) {
    console.error('Error parsing AI response:', error);
    return createFallbackResponse(aiResponse);
  }
}

// Helper function to convert parsed response to expected format
function convertParsedResponse(parsed) {
  // Convert new comparison format to existing format while preserving comparison data
  return {
    // Preserve comparison results
    comparisonResults: parsed.comparisonResults || { overallMatch: 0, summary: 'No comparison available' },
        
    // Extract elements from comparison
    elements: parsed.elementComparison?.extraElements || [],
        
    // Extract spacing issues from comparison
    spacing: {
      patterns: parsed.spacingComparison?.detectedSpacing?.gaps ? ['detected'] : [],
      gaps: parsed.spacingComparison?.detectedSpacing?.gaps || [],
      issues: parsed.spacingComparison?.deviations || []
    },
        
    // Extract layout issues from comparison
    layout: {
      type: parsed.layoutComparison?.detectedLayout || 'unknown',
      patterns: [],
      issues: [
        ...(parsed.layoutComparison?.alignmentIssues || []),
        ...(parsed.layoutComparison?.deviations || [])
      ]
    },
        
    // Extract typography issues from comparison
    typography: {
      fonts: parsed.typographyComparison?.detectedFonts || [],
      sizes: [],
      hierarchy: 'unknown',
      issues: parsed.typographyComparison?.deviations || []
    },
        
    // Extract color issues from comparison
    colors: {
      primary: parsed.colorComparison?.detectedColors || [],
      secondary: [],
      issues: parsed.colorComparison?.deviations || []
    },
        
    // Add comparison-specific data
    colorComparison: parsed.colorComparison,
    spacingComparison: parsed.spacingComparison,
    dimensionComparison: parsed.dimensionComparison,
    elementComparison: parsed.elementComparison,
    typographyComparison: parsed.typographyComparison,
    layoutComparison: parsed.layoutComparison,
    borderComparison: parsed.borderComparison,
    formFieldComparison: parsed.formFieldComparison,
        
    // Use critical issues and recommendations directly
    criticalIssues: parsed.criticalIssues || [],
    recommendations: parsed.recommendations || [],
    insights: [
      parsed.comparisonResults?.summary || 'Comparison analysis completed',
      ...(parsed.criticalIssues || [])
    ],
        
    confidence: parsed.confidence || 0.5
  };
}

// Create fallback response when AI doesn't return proper JSON
function createFallbackResponse(aiResponse) {
  // Extract any useful information from the text response
  const response = {
    comparisonResults: { overallMatch: 0, summary: 'Failed to parse AI response as JSON' },
    elements: [],
    spacing: { 
      patterns: [], 
      gaps: [], 
      issues: ['Could not parse detailed spacing from AI response'] 
    },
    layout: { 
      type: 'unknown', 
      patterns: [], 
      issues: ['Could not parse layout details'] 
    },
    typography: { 
      fonts: [], 
      sizes: [], 
      issues: ['Could not parse typography details'] 
    },
    colors: { 
      primary: [], 
      secondary: [], 
      issues: ['Could not parse color details'] 
    },
    recommendations: [],
    insights: [],
    rawResponse: aiResponse,
    confidence: 0
  };
  
  // Check if the AI said it cannot analyze images
  if (aiResponse.includes('cannot analyze') || aiResponse.includes('unable to analyze')) {
    response.comparisonResults.summary = 'AI reported it cannot analyze images. This might be a model limitation.';
    response.recommendations.push('Ensure you are using a valid OpenAI API key with GPT-4 Vision access');
    response.recommendations.push('Try regenerating the analysis or check the OpenAI API status');
    response.insights.push('The AI model may not have image analysis capabilities enabled');
  } else {
    response.recommendations.push('AI provided analysis but response was not in JSON format');
    response.recommendations.push('Check the console for the raw AI response');
    response.insights.push('Response parsing failed - manual review needed');
  }
  
  return response;
}

// Combine computer vision and AI analyses
function combineAnalyses(cvAnalysis, aiAnalysis) {
  return {
    // Keep original CV analysis
    ...cvAnalysis,
    
    // Add AI insights
    aiElements: aiAnalysis.elements || [],
    aiSpacing: aiAnalysis.spacing || {},
    aiLayout: aiAnalysis.layout || {},
    aiTypography: aiAnalysis.typography || {},
    aiColors: aiAnalysis.colors || {},
    aiAccessibility: aiAnalysis.accessibility || {},
    
    // Enhanced analysis combining both
    enhancedAnalysis: {
      totalElementsCV: cvAnalysis.elements?.length || 0,
      totalElements