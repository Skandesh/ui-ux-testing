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
    
    // Validate dimensions first
    const dimensionValidation = await validateDimensions(screenshotPath, figmaJSON);
    console.log('Dimension validation:', dimensionValidation);
    
    if (!dimensionValidation.isValid) {
      return res.status(400).json({
        error: 'Dimension validation failed',
        message: dimensionValidation.message,
        validation: dimensionValidation
      });
    }
    
    // Normalize screenshot to match Figma dimensions
    console.log('Starting screenshot normalization (standard analyze)...');
    const normalizedScreenshotPath = await normalizeScreenshotToFigma(screenshotPath, figmaJSON);
    console.log('Screenshot normalized to:', normalizedScreenshotPath);
    
    // Extract properties from Figma JSON
    console.log('Extracting Figma properties (standard analyze)...');
    const figmaProperties = extractFigmaProperties(figmaJSON);
    console.log('Extracted form fields:', figmaProperties.formFields?.length || 0);
    console.log('Field metrics:', figmaProperties.fieldMetrics);
    console.log('Form fields details:', JSON.stringify(figmaProperties.formFields, null, 2));
    console.log('Detected screen type:', figmaProperties.screenType);
    
    // Analyze normalized screenshot
    const detectedProperties = await analyzeScreenshot(normalizedScreenshotPath);
    
    // Compare properties
    const comparison = compareProperties(figmaProperties, detectedProperties);
    
    // Create spacing overlay visualization on normalized screenshot
    const spacingOverlay = await createSpacingOverlay(normalizedScreenshotPath, detectedProperties, comparison, Date.now());
    
    // Generate report
    const reportId = Date.now();
    const report = {
      id: reportId,
      timestamp: new Date().toISOString(),
      screenType: figmaProperties.screenType,
      dimensionValidation: dimensionValidation,
      figmaProperties: figmaProperties,
      detectedProperties: detectedProperties,
      accuracy: comparison.accuracy,
      totalMismatches: comparison.mismatches.length,
      colorMismatches: comparison.colorMismatches,
      propertyMismatches: comparison.mismatches,
      spacingMismatches: comparison.spacingMismatches || [],
      textMismatches: comparison.textMismatches || [],
      sizeMismatches: comparison.sizeMismatches || [],
      fieldMismatches: comparison.fieldMismatches || [],
      formFields: figmaProperties.formFields || [],
      fieldGroups: figmaProperties.fieldGroups || [],
      fieldMetrics: figmaProperties.fieldMetrics || null,
      visualizations: {
        spacingOverlay: spacingOverlay,
        screenshotPath: `/uploads/${path.basename(normalizedScreenshotPath)}`
      }
    };
    
    console.log('Sending report with form fields:', report.formFields?.length || 0);
    console.log('Report field metrics:', report.fieldMetrics);
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
    
    // Validate dimensions first
    const dimensionValidation = await validateDimensions(screenshotPath, figmaJSON);
    console.log('Dimension validation:', dimensionValidation);
    
    if (!dimensionValidation.isValid) {
      return res.status(400).json({
        error: 'Dimension validation failed',
        message: dimensionValidation.message,
        validation: dimensionValidation
      });
    }
    
    // Normalize screenshot to match Figma dimensions
    console.log('Starting screenshot normalization...');
    const normalizedScreenshotPath = await normalizeScreenshotToFigma(screenshotPath, figmaJSON);
    console.log('Screenshot normalized to:', normalizedScreenshotPath);
    
    // Extract properties from Figma JSON
    console.log('Extracting Figma properties...');
    const figmaProperties = extractFigmaProperties(figmaJSON);
    console.log('Extracted form fields:', figmaProperties.formFields?.length || 0);
    console.log('Field metrics:', figmaProperties.fieldMetrics);
    console.log('Form fields details:', JSON.stringify(figmaProperties.formFields, null, 2));
    console.log('Detected screen type:', figmaProperties.screenType);
    
    // Perform standard computer vision analysis on normalized screenshot
    const detectedProperties = await analyzeScreenshot(normalizedScreenshotPath);
    
    // Perform AI-powered analysis on normalized screenshot
    const aiAnalysis = await analyzeWithOpenAI(normalizedScreenshotPath, figmaProperties, openaiApiKey);
    
    // Combine both analyses
    const enhancedDetectedProperties = combineAnalyses(detectedProperties, aiAnalysis, figmaProperties);
    
    // Compare properties with enhanced comparison logic
    const comparison = comparePropertiesEnhanced(figmaProperties, enhancedDetectedProperties);
    
    // Create spacing overlay visualization
    const spacingOverlay = await createSpacingOverlay(screenshotPath, detectedProperties, comparison, Date.now());
    
    // Generate comprehensive report
    const reportId = Date.now();
    const report = {
      id: reportId,
      timestamp: new Date().toISOString(),
      analysisType: 'AI_ENHANCED',
      screenType: figmaProperties.screenType,
      dimensionValidation: dimensionValidation,
      figmaProperties: figmaProperties,
      detectedProperties: enhancedDetectedProperties,
      aiAnalysis: aiAnalysis,
      formFields: figmaProperties.formFields || [],
      fieldGroups: figmaProperties.fieldGroups || [],
      fieldMetrics: figmaProperties.fieldMetrics || null,
      // Field-based analysis results
      fieldAnalysis: {
        isFieldBased: comparison.isFieldBased || false,
        detectedFields: enhancedDetectedProperties.detectedFields || [],
        fieldMapping: enhancedDetectedProperties.fieldMapping || null,
        fieldComparisons: comparison.fieldComparisons || null,
        screenTypeMatch: enhancedDetectedProperties.screenType?.matchesExpected || false
      },
      accuracy: comparison.accuracy,
      confidenceScore: aiAnalysis.confidence || 0.8,
      totalMismatches: comparison.mismatches.length,
      colorMismatches: comparison.colorMismatches,
      propertyMismatches: comparison.mismatches,
      spacingMismatches: comparison.spacingMismatches || [],
      textMismatches: comparison.textMismatches || [],
      sizeMismatches: comparison.sizeMismatches || [],
      layoutMismatches: comparison.layoutMismatches || [],
      recommendations: aiAnalysis.recommendations || [],
      insights: aiAnalysis.insights || [],
      visualizations: {
        spacingOverlay: spacingOverlay,
        screenshotPath: `/uploads/${path.basename(normalizedScreenshotPath)}`
      }
    };
    
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

// Validate screenshot dimensions against Figma design
async function validateDimensions(screenshotPath, figmaJSON) {
  try {
    // Extract Figma dimensions from the parsed properties
    const figmaProperties = extractFigmaProperties(figmaJSON);
    let figmaBounds = figmaProperties.dimensions;
    
    // If no dimensions found, try to get from root node
    if (!figmaBounds?.width || !figmaBounds?.height) {
      // Try to find root node with absoluteBoundingBox
      const findRootBounds = (node) => {
        if (node.absoluteBoundingBox) {
          return {
            width: Math.round(node.absoluteBoundingBox.width),
            height: Math.round(node.absoluteBoundingBox.height)
          };
        }
        if (node.children) {
          for (const child of node.children) {
            const bounds = findRootBounds(child);
            if (bounds) return bounds;
          }
        }
        return null;
      };
      
      figmaBounds = findRootBounds(figmaJSON) || { 
        width: 375,  // Common mobile width
        height: 812  // Common mobile height (iPhone X/11)
      };
    }
    
    // Get screenshot metadata
    const metadata = await sharp(screenshotPath).metadata();
    
    // Calculate aspect ratios
    const figmaAspectRatio = figmaBounds.width / figmaBounds.height;
    const screenshotAspectRatio = metadata.width / metadata.height;
    
    // Calculate aspect ratio difference
    const aspectRatioDiff = Math.abs(figmaAspectRatio - screenshotAspectRatio);
    const aspectRatioTolerance = 0.05; // 5% tolerance
    
    const validation = {
      isValid: aspectRatioDiff <= aspectRatioTolerance,
      figmaDimensions: figmaBounds,
      screenshotDimensions: {
        width: metadata.width,
        height: metadata.height
      },
      figmaAspectRatio: figmaAspectRatio.toFixed(3),
      screenshotAspectRatio: screenshotAspectRatio.toFixed(3),
      aspectRatioDifference: aspectRatioDiff.toFixed(3),
      message: ''
    };
    
    if (!validation.isValid) {
      validation.message = `Aspect ratio mismatch: Figma (${validation.figmaAspectRatio}) vs Screenshot (${validation.screenshotAspectRatio}). Please upload a screenshot with matching aspect ratio.`;
    } else {
      validation.message = 'Dimensions validated successfully';
    }
    
    return validation;
  } catch (error) {
    console.error('Dimension validation error:', error);
    throw error;
  }
}

// Normalize screenshot to match Figma dimensions
async function normalizeScreenshotToFigma(screenshotPath, figmaJSON) {
  try {
    // First validate dimensions
    const validation = await validateDimensions(screenshotPath, figmaJSON);
    
    if (!validation.isValid) {
      console.warn('Dimension validation failed:', validation.message);
      // You may want to throw an error here or handle it differently
      // For now, we'll continue with normalization but log the warning
    }
    
    const figmaBounds = validation.figmaDimensions;
    const metadata = validation.screenshotDimensions;
    
    // Check if dimensions already match
    if (metadata.width === figmaBounds.width && metadata.height === figmaBounds.height) {
      console.log('Screenshot dimensions already match Figma design');
      return screenshotPath;
    }
    
    // Log dimension mismatch
    console.log(`Normalizing screenshot: ${metadata.width}x${metadata.height} -> ${figmaBounds.width}x${figmaBounds.height}`);
    
    // Create normalized image path
    const normalizedPath = path.join(uploadsDir, `normalized-${Date.now()}.png`);
    
    // Resize screenshot to match Figma dimensions
    await sharp(screenshotPath)
      .resize(figmaBounds.width, figmaBounds.height, { 
        fit: 'contain', 
        background: { r: 255, g: 255, b: 255, alpha: 1 } 
      })
      .toFile(normalizedPath);
    
    return normalizedPath;
  } catch (error) {
    console.error('Error normalizing screenshot:', error);
    console.log('Proceeding with original screenshot.');
    return screenshotPath;
  }
}

// Analyze screenshot using OpenAI Vision API
async function analyzeWithOpenAI(screenshotPath, figmaProperties, apiKey) {
  try {
    const openai = new OpenAI({ apiKey: apiKey });
    
    // Convert image to base64
    const imageBuffer = fs.readFileSync(screenshotPath);
    const base64Image = imageBuffer.toString('base64');
    
    // Check if we should do field-specific analysis
    const hasFormFields = figmaProperties.formFields && figmaProperties.formFields.length > 0;
    
    // Create appropriate prompt based on whether we have form fields
    let prompt;
    let systemMessage;
    
    if (hasFormFields) {
      // Field-specific analysis
      prompt = createFieldAnalysisPrompt(figmaProperties);
      systemMessage = "You are a precise UI field detection and validation tool. Your job is to:\n1. Detect ALL form fields (text inputs, buttons, checkboxes, dropdowns, etc.) in the screenshot\n2. Note their EXACT pixel positions (x,y coordinates from top-left corner)\n3. Measure their dimensions (width × height)\n4. Identify visual properties (colors, borders, text)\n5. Match them with expected fields from the design specification\n\nBe extremely accurate with coordinates and dimensions. The analysis depends on precise position data.\n\nYou MUST respond with ONLY a JSON object - no other text, no markdown, no explanations. Just the raw JSON starting with { and ending with }.";
    } else {
      // General UI analysis
      prompt = createUIAnalysisPrompt(figmaProperties);
      systemMessage = "You are a UI/UX comparison tool that analyzes screenshots against design specifications. You MUST respond with ONLY a JSON object - no other text, no markdown, no explanations. Just the raw JSON starting with { and ending with }.";
    }
    
    console.log('Sending image to OpenAI for analysis...');
    console.log('Analysis type:', hasFormFields ? 'Field-specific' : 'General UI');
    
    if (hasFormFields) {
      console.log(`Analyzing ${figmaProperties.formFields.length} expected fields:`);
      figmaProperties.formFields.forEach((field, index) => {
        const x = field.properties?.position?.x || 0;
        const y = field.properties?.position?.y || 0;
        console.log(`  ${index + 1}. ${field.type} "${field.name}" at (${x}, ${y})`);
      });
    }
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: systemMessage
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
    
    // Log field detection results if available
    if (structuredAnalysis.detectedFields) {
      console.log(`OpenAI detected ${structuredAnalysis.detectedFields.length} fields:`);
      structuredAnalysis.detectedFields.forEach((field, index) => {
        console.log(`  ${index + 1}. ${field.type} at (${field.bounds?.x || 0}, ${field.bounds?.y || 0})`);
      });
    }
    
    if (structuredAnalysis.fieldMatching) {
      console.log(`Field matching results:`);
      console.log(`  - Successful matches: ${structuredAnalysis.fieldMatching.matches?.length || 0}`);
      console.log(`  - Unmatched expected: ${structuredAnalysis.fieldMatching.unmatchedExpected?.length || 0}`);
      console.log(`  - Unmatched detected: ${structuredAnalysis.fieldMatching.unmatchedDetected?.length || 0}`);
    }
    
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

// Create detailed prompt for UI analysis
// Create prompt specifically for field detection and analysis
function createFieldAnalysisPrompt(figmaProperties) {
  const screenType = figmaProperties.screenType;
  const formFields = figmaProperties.formFields || [];
  
  // Prepare field specifications
  const fieldSpecs = formFields.map(field => ({
    name: field.name,
    type: field.type,
    position: {
      x: Math.round(field.properties.position?.x || 0),
      y: Math.round(field.properties.position?.y || 0)
    },
    dimensions: {
      width: Math.round(field.properties.dimensions?.width || 0),
      height: Math.round(field.properties.dimensions?.height || 0)
    },
    styling: {
      backgroundColor: field.properties.styling?.backgroundColor || 'transparent',
      borderColor: field.properties.styling?.borderColor || 'none',
      borderRadius: field.properties.styling?.borderRadius || 0
    },
    label: field.label || '',
    placeholder: field.placeholder || ''
  }));
  
  return `You are analyzing a UI screenshot to validate form field implementation against a Figma design.

CONTEXT:
This is a ${screenType.type} screen with ${formFields.length} expected form fields. Your task is to:
1. Identify ALL form fields (inputs, buttons, checkboxes, etc.) in the screenshot
2. Match each detected field with the expected fields from the Figma design
3. Report any differences in position, size, style, or content

EXPECTED FIELDS FROM FIGMA DESIGN:
${fieldSpecs.map((field, index) => `
Field ${index + 1}: ${field.type.toUpperCase()} - "${field.name}"
   - Expected Position: (${field.position.x}, ${field.position.y})
   - Expected Size: ${field.dimensions.width}×${field.dimensions.height} pixels
   - Label Text: "${field.label || 'No label'}"
   - Placeholder: "${field.placeholder || 'No placeholder'}"
   - Visual Style:
     * Background Color: ${field.styling.backgroundColor}
     * Border Color: ${field.styling.borderColor}
     * Border Radius: ${field.styling.borderRadius}px
`).join('')}

ANALYSIS INSTRUCTIONS:
1. Scan the entire screenshot systematically from top to bottom
2. Identify every interactive element (input fields, buttons, checkboxes, etc.)
3. For each detected field, note its exact position and dimensions
4. Compare visual properties (colors, borders, rounded corners)
5. Check for text content (labels, placeholders, button text)
6. Match detected fields to expected fields based on position and type

IMPORTANT:
- Be precise with coordinates - they are measured from top-left corner
- Report ALL fields you see, even if they don't match expected fields
- Pay attention to subtle differences in styling (border colors, corner radius)
- Note if fields appear disabled or have focus states

Return a JSON object with this EXACT structure:
{
  "screenType": {
    "detected": "login|register|profile|search|contact|checkout|form|unknown",
    "confidence": 0.0-1.0,
    "matchesExpected": true|false
  },
  "detectedFields": [
    {
      "type": "input|button|checkbox|radio|select|textarea",
      "bounds": {
        "x": 0,
        "y": 0,
        "width": 0,
        "height": 0
      },
      "properties": {
        "backgroundColor": "#hexcode or transparent",
        "borderColor": "#hexcode or none",
        "borderRadius": 0,
        "hasBorder": true|false,
        "hasPlaceholder": true|false,
        "placeholderText": "detected placeholder text or empty",
        "labelText": "detected label text or empty",
        "buttonText": "for buttons only, the button text",
        "isDisabled": true|false,
        "hasFocus": true|false
      },
      "confidence": 0.0-1.0
    }
  ],
  "fieldMatching": {
    "totalExpected": ${formFields.length},
    "totalDetected": 0,
    "matches": [
      {
        "expectedFieldName": "field name from design",
        "detectedFieldIndex": 0,
        "matchConfidence": 0.0-1.0,
        "positionMatch": true|false,
        "typeMatch": true|false,
        "styleMatch": true|false
      }
    ],
    "unmatchedExpected": ["list of expected field names that weren't found"],
    "unmatchedDetected": [0, 1, 2]
  },
  "issues": [
    {
      "type": "missing|extra|mismatch|style",
      "severity": "critical|major|minor",
      "description": "Clear description of the issue"
    }
  ]
}`;
}

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
  
  return `Analyze the provided screenshot and compare it against the Figma design specifications below. Return your analysis as a JSON object.

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

TASK: Compare the screenshot against the specifications above.

Return a JSON object with this exact structure:
{
  "comparisonResults": {
    "overallMatch": 0-100,
    "summary": "Brief summary of how well the implementation matches the design"
  },
  "colorComparison": {
    "figmaColors": ["list of expected colors from design"],
    "detectedColors": ["list of colors found in screenshot"],
    "matches": [
      {
        "figmaColor": "#hexcode",
        "closestDetected": "#hexcode",
        "deltaE": 0.0,
        "match": "exact|close|different"
      }
    ],
    "missingColors": ["colors in Figma but not in screenshot"],
    "extraColors": ["colors in screenshot but not in Figma"],
    "deviations": ["Specific color deviations, e.g., 'Button color is #2196F3 instead of specified #1976D2'"]
  },
  "spacingComparison": {
    "figmaSpacing": {
      "padding": {"top": 0, "right": 0, "bottom": 0, "left": 0},
      "gap": 0
    },
    "detectedSpacing": {
      "padding": {"top": 0, "right": 0, "bottom": 0, "left": 0},
      "gaps": [list of detected gaps between elements]
    },
    "deviations": [
      "Padding is 12px instead of specified 16px",
      "Gap between elements is 20px instead of specified 24px"
    ]
  },
  "dimensionComparison": {
    "figmaDimensions": {"width": 0, "height": 0},
    "detectedDimensions": {"width": 0, "height": 0},
    "deviations": ["Width is 380px instead of specified 400px"]
  },
  "elementComparison": {
    "figmaElementCount": 0,
    "detectedElementCount": 0,
    "missingElements": [
      {
        "type": "element type",
        "name": "element name from Figma",
        "expectedPosition": {"x": 0, "y": 0}
      }
    ],
    "extraElements": [
      {
        "type": "element type",
        "position": {"x": 0, "y": 0},
        "description": "Element found but not in design"
      }
    ],
    "positionDeviations": [
      {
        "element": "element name",
        "expectedPosition": {"x": 0, "y": 0},
        "actualPosition": {"x": 0, "y": 0},
        "deviation": {"x": 0, "y": 0}
      }
    ]
  },
  "typographyComparison": {
    "figmaFonts": ["expected fonts"],
    "detectedFonts": ["detected fonts"],
    "deviations": ["Font is Arial instead of specified Roboto"]
  },
  "layoutComparison": {
    "figmaLayout": "specified layout mode",
    "detectedLayout": "detected layout pattern",
    "alignmentIssues": ["Elements not aligned as specified"],
    "deviations": ["Layout appears to be grid instead of specified flexbox"]
  },
  "borderComparison": {
    "figmaBorders": {"radius": 0, "width": 0},
    "detectedBorders": {"radius": 0, "width": 0},
    "deviations": ["Border radius is 4px instead of specified 8px"]
  },
  "criticalIssues": [
    "Most important deviations that significantly impact the design"
  ],
  "recommendations": [
    "Specific fixes needed to match the Figma design, e.g., 'Increase padding to 16px to match design'"
  ],
  "confidence": 0.0-1.0
}

IMPORTANT INSTRUCTIONS:
1. Focus on COMPARING the screenshot AGAINST the Figma specifications
2. For each property, explicitly state whether it matches or deviates from the design, and by how much
3. Output ONLY the JSON object - no explanatory text before or after
4. Do NOT say "I cannot analyze images" - you CAN analyze this image
5. Start your response with { and end with }`;
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
  // Check if this is a field-specific response
  if (parsed.detectedFields && parsed.fieldMatching) {
    // Field-specific response format
    return {
      // Field detection results
      screenType: parsed.screenType || { detected: 'unknown', confidence: 0, matchesExpected: false },
      detectedFields: parsed.detectedFields || [],
      fieldMatching: parsed.fieldMatching || {
        totalExpected: 0,
        totalDetected: 0,
        matches: [],
        unmatchedExpected: [],
        unmatchedDetected: []
      },
      fieldIssues: parsed.issues || [],
      
      // Also include standard comparison results for compatibility
      comparisonResults: {
        overallMatch: parsed.fieldMatching ? 
          Math.round((parsed.fieldMatching.matches.length / Math.max(parsed.fieldMatching.totalExpected, 1)) * 100) : 0,
        summary: `Detected ${parsed.fieldMatching?.totalDetected || 0} fields, expected ${parsed.fieldMatching?.totalExpected || 0}`
      },
      
      // Empty standard properties for compatibility
      elements: [],
      spacing: { patterns: [], gaps: [], issues: [] },
      layout: { type: 'unknown', patterns: [], issues: [] },
      typography: { fonts: [], sizes: [], hierarchy: 'unknown', issues: [] },
      colors: { primary: [], secondary: [], issues: [] }
    };
  }
  
  // Standard UI comparison response
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
function combineAnalyses(cvAnalysis, aiAnalysis, figmaProperties) {
  // Check if we have field-specific AI analysis
  const hasFieldAnalysis = aiAnalysis.detectedFields && aiAnalysis.fieldMatching;
  
  if (hasFieldAnalysis && figmaProperties?.formFields) {
    // Perform field mapping
    const fieldMapping = mapFieldsToDetected(
      figmaProperties.formFields,
      aiAnalysis.detectedFields,
      figmaProperties.dimensions
    );
    
    return {
      // Keep original CV analysis
      ...cvAnalysis,
      
      // Add field-specific results
      screenType: aiAnalysis.screenType,
      detectedFields: aiAnalysis.detectedFields,
      fieldMatching: aiAnalysis.fieldMatching,
      fieldMapping: fieldMapping,
      fieldIssues: aiAnalysis.fieldIssues || [],
      
      // Add AI insights
      aiElements: aiAnalysis.elements || [],
      aiSpacing: aiAnalysis.spacing || {},
      aiLayout: aiAnalysis.layout || {},
      aiTypography: aiAnalysis.typography || {},
      aiColors: aiAnalysis.colors || {},
      aiAccessibility: aiAnalysis.accessibility || {},
      
      // Enhanced analysis with field focus
      enhancedAnalysis: {
        isFieldBased: true,
        fieldMatchRate: fieldMapping.summary?.matchRate || 0,
        totalFigmaFields: figmaProperties.formFields.length,
        totalDetectedFields: aiAnalysis.detectedFields?.length || 0,
        successfulMatches: fieldMapping.mappings?.length || 0,
        unmatchedFigmaFields: fieldMapping.unmatchedFigma?.length || 0,
        unmatchedDetectedFields: fieldMapping.unmatchedDetected?.length || 0,
        overallFieldScore: fieldMapping.overallScore || 0
      }
    };
  }
  
  // Standard analysis without field detection
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
      totalElementsAI: aiAnalysis.elements?.length || 0,
      spacingPatternsCV: cvAnalysis.spacing?.spacingPatterns?.length || 0,
      spacingPatternsAI: aiAnalysis.spacing?.patterns?.length || 0,
      layoutComplexityCV: cvAnalysis.layout?.complexity || 'unknown',
      layoutComplexityAI: aiAnalysis.layout?.type || 'unknown',
      confidenceScore: aiAnalysis.confidence || 0.5
    }
  };
}

// Enhanced comparison with AI insights
function comparePropertiesEnhanced(figma, detected) {
  // Start with basic comparison
  const basicComparison = compareProperties(figma, detected);
  
  // Add AI-enhanced comparisons
  const layoutMismatches = [];
  const spacingMismatches = [];
  
  // Compare AI-detected spacing with Figma spacing
  if (detected.aiSpacing && detected.aiSpacing.issues) {
    detected.aiSpacing.issues.forEach(issue => {
      spacingMismatches.push({
        type: 'spacing',
        issue: issue,
        severity: 'medium',
        source: 'AI_ANALYSIS'
      });
    });
  }
  
  // Compare layout patterns
  if (detected.aiLayout && detected.aiLayout.issues) {
    detected.aiLayout.issues.forEach(issue => {
      layoutMismatches.push({
        type: 'layout',
        issue: issue,
        severity: 'medium',
        source: 'AI_ANALYSIS'
      });
    });
  }
  
  // Add field-level comparisons if available
  let fieldComparisonResults = null;
  let fieldLevelAccuracy = null;
  
  if (detected.fieldMapping && detected.fieldMapping.mappings) {
    // Extract field comparisons from mappings
    const fieldComparisons = detected.fieldMapping.mappings.map(mapping => ({
      fieldName: mapping.figmaField.name,
      fieldType: mapping.figmaField.type,
      matchScore: mapping.matchScore,
      comparison: mapping.comparison,
      differences: mapping.comparison?.differences || []
    }));
    
    // Calculate field-level accuracy
    const totalFieldScore = fieldComparisons.reduce((sum, fc) => 
      sum + (fc.comparison?.overallScore || 0), 0);
    fieldLevelAccuracy = detected.fieldMapping.mappings.length > 0 ?
      (totalFieldScore / detected.fieldMapping.mappings.length) : 0;
    
    fieldComparisonResults = {
      comparisons: fieldComparisons,
      unmatchedFigmaFields: detected.fieldMapping.unmatchedFigma || [],
      unmatchedDetectedFields: detected.fieldMapping.unmatchedDetected || [],
      summary: detected.fieldMapping.summary || {}
    };
  }
  
  // Calculate enhanced accuracy including AI insights
  const aiInsightScore = detected.enhancedAnalysis?.confidenceScore || 0.5;
  let enhancedAccuracy;
  
  if (fieldLevelAccuracy !== null && detected.enhancedAnalysis?.isFieldBased) {
    // If we have field-based analysis, weight it heavily
    enhancedAccuracy = (fieldLevelAccuracy * 100 * 0.6 + basicComparison.accuracy * 0.3 + aiInsightScore * 100 * 0.1).toFixed(2);
  } else {
    // Standard weighted accuracy
    enhancedAccuracy = (basicComparison.accuracy * 0.7 + aiInsightScore * 100 * 0.3).toFixed(2);
  }
  
  return {
    ...basicComparison,
    accuracy: enhancedAccuracy,
    layoutMismatches,
    spacingMismatches: [...(basicComparison.spacingMismatches || []), ...spacingMismatches],
    enhancedWithAI: true,
    aiConfidence: aiInsightScore,
    fieldComparisons: fieldComparisonResults,
    isFieldBased: detected.enhancedAnalysis?.isFieldBased || false
  };
}

// Extract comprehensive properties from Figma JSON
function extractFigmaProperties(json) {
  const properties = {
    colors: [],
    typography: [],
    spacing: {},
    dimensions: {},
    layout: {},
    borders: {},
    shadows: {},
    elements: [],
    hierarchy: [],
    formFields: []
  };
  
  const colorSet = new Set();
  let elementIndex = 0;
  const allNodes = []; // Collect all nodes for proximity searches
  let frameOrigin = null; // Store the frame's origin to normalize coordinates
  
  // Helper function to find nearby text nodes for label detection
  function findNearbyText(node, allTextNodes, maxDistance = 50) {
    if (!node.absoluteBoundingBox) return null;
    
    const nodeX = node.absoluteBoundingBox.x;
    const nodeY = node.absoluteBoundingBox.y;
    let closestText = null;
    let minDistance = maxDistance;
    
    allTextNodes.forEach(textNode => {
      if (!textNode.absoluteBoundingBox || !textNode.characters) return;
      
      const textX = textNode.absoluteBoundingBox.x;
      const textY = textNode.absoluteBoundingBox.y;
      
      // Calculate Euclidean distance
      const distance = Math.sqrt(Math.pow(nodeX - textX, 2) + Math.pow(nodeY - textY, 2));
      
      // Prefer labels above or to the left of the field
      const isAbove = textY < nodeY;
      const isLeft = textX < nodeX && Math.abs(textY - nodeY) < 20;
      
      if (distance < minDistance && (isAbove || isLeft)) {
        minDistance = distance;
        closestText = textNode.characters;
      }
    });
    
    return closestText;
  }
  
  // Helper function to extract placeholder text from child nodes
  function extractPlaceholder(node, childNodes) {
    if (!node.absoluteBoundingBox) return null;
    
    const nodeBounds = node.absoluteBoundingBox;
    
    for (const child of childNodes) {
      if (child.type === 'TEXT' && child.absoluteBoundingBox && child.characters) {
        const childBounds = child.absoluteBoundingBox;
        
        // Check if text node is within parent bounds
        if (childBounds.x >= nodeBounds.x &&
            childBounds.y >= nodeBounds.y &&
            childBounds.x + childBounds.width <= nodeBounds.x + nodeBounds.width &&
            childBounds.y + childBounds.height <= nodeBounds.y + nodeBounds.height) {
          return child.characters;
        }
      }
    }
    
    return null;
  }
  
  // Helper function to traverse nested nodes with enhanced property extraction
  function traverseNode(node, parentId = null, depth = 0) {
    const currentElementId = `element_${elementIndex++}`;
    
    // Create element structure for hierarchy tracking
    const element = {
      id: currentElementId,
      type: node.type,
      name: node.name || `Unnamed ${node.type}`,
      parentId: parentId,
      depth: depth,
      properties: {}
    };
    
    // Extract position and dimensions
    if (node.absoluteBoundingBox) {
      // Store frame origin for the first node (root frame)
      if (depth === 0 && !frameOrigin) {
        frameOrigin = {
          x: node.absoluteBoundingBox.x,
          y: node.absoluteBoundingBox.y
        };
      }
      
      // Calculate relative position (relative to the frame, not the canvas)
      const relativeX = frameOrigin ? node.absoluteBoundingBox.x - frameOrigin.x : node.absoluteBoundingBox.x;
      const relativeY = frameOrigin ? node.absoluteBoundingBox.y - frameOrigin.y : node.absoluteBoundingBox.y;
      
      element.properties.position = {
        x: Math.round(relativeX),
        y: Math.round(relativeY),
        width: Math.round(node.absoluteBoundingBox.width),
        height: Math.round(node.absoluteBoundingBox.height)
      };
      
      // Set global dimensions from root element
      if (!properties.dimensions.width && depth === 0) {
        properties.dimensions = {
          width: element.properties.position.width,
          height: element.properties.position.height
        };
      }
    }
    
    // Extract layout constraints
    if (node.constraints) {
      element.properties.constraints = {
        horizontal: node.constraints.horizontal,
        vertical: node.constraints.vertical
      };
    }
    
    // Extract colors from fills
    if (node.fills && Array.isArray(node.fills)) {
      node.fills.forEach((fill, index) => {
        if (fill.type === 'SOLID' && fill.color && fill.visible !== false) {
          const hex = rgbToHex(fill.color);
          const opacity = fill.opacity !== undefined ? fill.opacity : 1;
          
          if (!colorSet.has(hex)) {
            colorSet.add(hex);
            properties.colors.push({
              property: properties.colors.length === 0 ? 'primaryColor' : `color_${properties.colors.length}`,
              value: hex,
              opacity: opacity,
              elementId: currentElementId,
              elementType: node.type,
              usage: 'fill'
            });
          }
        }
      });
    }
    
    // Extract stroke/border properties
    if (node.strokes && Array.isArray(node.strokes)) {
      node.strokes.forEach((stroke, index) => {
        if (stroke.type === 'SOLID' && stroke.color && stroke.visible !== false) {
          const hex = rgbToHex(stroke.color);
          const strokeWeight = node.strokeWeight || 1;
          
          if (!colorSet.has(hex)) {
            colorSet.add(hex);
            properties.colors.push({
              property: `borderColor_${properties.colors.length}`,
              value: hex,
              elementId: currentElementId,
              usage: 'stroke'
            });
          }
          
          // Store border properties
          element.properties.border = {
            width: strokeWeight,
            color: hex,
            style: 'solid'
          };
        }
      });
    }
    
    // Extract corner radius
    if (node.cornerRadius !== undefined) {
      element.properties.borderRadius = node.cornerRadius;
      if (!properties.borders.borderRadius) {
        properties.borders.borderRadius = node.cornerRadius;
      }
    }
    
    // Extract individual corner radii
    if (node.rectangleCornerRadii) {
      element.properties.borderRadius = {
        topLeft: node.rectangleCornerRadii[0] || 0,
        topRight: node.rectangleCornerRadii[1] || 0,
        bottomRight: node.rectangleCornerRadii[2] || 0,
        bottomLeft: node.rectangleCornerRadii[3] || 0
      };
    }
    
    // Extract shadow effects
    if (node.effects && Array.isArray(node.effects)) {
      const shadows = node.effects.filter(effect => 
        effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW'
      );
      
      if (shadows.length > 0) {
        element.properties.shadows = shadows.map(shadow => ({
          type: shadow.type,
          color: shadow.color ? rgbToHex(shadow.color) : '#000000',
          offset: {
            x: shadow.offset?.x || 0,
            y: shadow.offset?.y || 0
          },
          radius: shadow.radius || 0,
          spread: shadow.spread || 0,
          visible: shadow.visible !== false
        }));
        
        // Store first shadow in global properties
        if (!properties.shadows.dropShadow) {
          properties.shadows = element.properties.shadows[0];
        }
      }
    }
    
    // Extract typography for TEXT nodes
    if (node.type === 'TEXT') {
      const textProps = {
        elementId: currentElementId,
        fontFamily: node.style?.fontFamily || 'Unknown',
        fontSize: node.style?.fontSize || 16,
        fontWeight: node.style?.fontWeight || 400,
        lineHeight: node.style?.lineHeightPx || node.style?.lineHeightPercent || 'normal',
        letterSpacing: node.style?.letterSpacing || 0,
        textAlign: node.style?.textAlignHorizontal || 'left',
        textCase: node.style?.textCase || 'none',
        textDecoration: node.style?.textDecoration || 'none',
        content: node.characters || ''
      };
      
      properties.typography.push(textProps);
      element.properties.typography = textProps;
      
      // Extract text color
      if (node.fills && node.fills[0] && node.fills[0].color) {
        const textColorHex = rgbToHex(node.fills[0].color);
        textProps.color = textColorHex;
        
        if (!colorSet.has(textColorHex)) {
          colorSet.add(textColorHex);
          properties.colors.push({
            property: 'textColor',
            value: textColorHex,
            elementId: currentElementId,
            usage: 'text'
          });
        }
      }
    }
    
    // Extract padding and layout properties
    if (node.paddingLeft !== undefined || node.paddingTop !== undefined || 
        node.paddingRight !== undefined || node.paddingBottom !== undefined) {
      
      element.properties.padding = {
        top: node.paddingTop || 0,
        right: node.paddingRight || 0,
        bottom: node.paddingBottom || 0,
        left: node.paddingLeft || 0
      };
      
      // Store in global spacing if not already set
      if (!properties.spacing.padding) {
        properties.spacing.padding = element.properties.padding;
      }
    }
    
    // Extract layout properties for containers
    if (node.layoutMode) {
      element.properties.layout = {
        mode: node.layoutMode, // 'VERTICAL', 'HORIZONTAL', 'NONE'
        primaryAxisSizingMode: node.primaryAxisSizingMode,
        counterAxisSizingMode: node.counterAxisSizingMode,
        primaryAxisAlignItems: node.primaryAxisAlignItems,
        counterAxisAlignItems: node.counterAxisAlignItems,
        itemSpacing: node.itemSpacing || 0
      };
      
      // Store layout info globally
      if (!properties.layout.mode) {
        properties.layout = element.properties.layout;
      }
    }
    
    // Extract spacing between items
    if (node.itemSpacing !== undefined) {
      element.properties.gap = node.itemSpacing;
      if (!properties.spacing.gap) {
        properties.spacing.gap = node.itemSpacing;
      }
    }
    
    // Store node for proximity searches
    allNodes.push({ ...node, elementId: currentElementId, element });
    
    // Detect form fields (inputs, buttons) by patterns
    const fieldPatterns = /input|field|email|password|username|search|button|submit|login|register|signup|signin/i;
    const isFormField = (node.type === 'RECTANGLE' || node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') 
                        && fieldPatterns.test(node.name);
    
    // Also detect INSTANCE nodes that contain text (likely form fields)
    const isInstanceWithText = node.type === 'INSTANCE' && 
                               node.children && 
                               node.children.some(child => 
                                 child.type === 'TEXT' && 
                                 child.characters && 
                                 /@|example\.com|username/i.test(child.characters)
                               );
    
    if ((isFormField || isInstanceWithText) && node.absoluteBoundingBox) {
      // Determine field type with more granularity
      let fieldType = 'input';
      const nameLower = node.name.toLowerCase();
      
      if (/button|submit|login|register|signup|signin|continue|next/i.test(nameLower)) {
        fieldType = 'button';
      } else if (/password/i.test(nameLower)) {
        fieldType = 'password';
      } else if (/email/i.test(nameLower)) {
        fieldType = 'email';
      } else if (/checkbox|check/i.test(nameLower)) {
        fieldType = 'checkbox';
      } else if (/radio/i.test(nameLower)) {
        fieldType = 'radio';
      } else if (/select|dropdown/i.test(nameLower)) {
        fieldType = 'select';
      } else if (/textarea|text area/i.test(nameLower)) {
        fieldType = 'textarea';
      }
      
      const field = {
        id: currentElementId,
        name: node.name,
        type: fieldType,
        nodeType: node.type,
        componentId: node.componentId || null,
        properties: {
          position: element.properties.position,
          dimensions: {
            width: element.properties.position?.width,
            height: element.properties.position?.height
          },
          styling: {
            backgroundColor: element.properties.backgroundColor,
            borderColor: element.properties.border?.color,
            borderWidth: element.properties.border?.width,
            borderRadius: element.properties.borderRadius,
            opacity: element.properties.opacity,
            // Additional styling details
            fills: node.fills || [],
            strokes: node.strokes || [],
            effects: node.effects || []
          },
          constraints: node.constraints || {},
          layoutAlign: node.layoutAlign || null,
          layoutGrow: node.layoutGrow || 0
        },
        placeholder: null,
        label: null,
        // Additional metadata
        metadata: {
          isVisible: node.visible !== false,
          isLocked: node.locked === true,
          // Field state indicators
          hasPlaceholder: false,
          hasLabel: false,
          hasIcon: false,
          // Validation indicators
          isRequired: false,
          validationType: null
        },
        // Group fields by their parent container
        parentContainerId: parentId,
        parentContainerName: allNodes.find(n => n.elementId === parentId)?.name || null
      };
      
      // Extract placeholder text from children
      if (node.children && Array.isArray(node.children)) {
        field.placeholder = extractPlaceholder(node, node.children);
        field.metadata.hasPlaceholder = !!field.placeholder;
        
        // Check for icons in children
        field.metadata.hasIcon = node.children.some(child => 
          child.type === 'VECTOR' || 
          child.type === 'BOOLEAN_OPERATION' ||
          (child.name && /icon|svg/i.test(child.name))
        );
        
        // Check for required indicators
        field.metadata.isRequired = node.children.some(child => 
          child.type === 'TEXT' && 
          child.characters && 
          /\*|required/i.test(child.characters)
        );
      }
      
      // Infer validation type from field type and name
      if (fieldType === 'email') {
        field.metadata.validationType = 'email';
      } else if (fieldType === 'password') {
        field.metadata.validationType = 'password';
      } else if (/phone|tel/i.test(nameLower)) {
        field.metadata.validationType = 'phone';
      } else if (/url|link/i.test(nameLower)) {
        field.metadata.validationType = 'url';
      }
      
      properties.formFields.push(field);
    }
    
    // Add element to collection
    properties.elements.push(element);
    properties.hierarchy.push({
      id: currentElementId,
      parentId: parentId,
      depth: depth,
      type: node.type,
      name: element.name
    });
    
    // Traverse children with updated parent context
    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(child => traverseNode(child, currentElementId, depth + 1));
    }
  }
  
  // Start traversal
  traverseNode(json);
  
  // Post-process form fields: find labels and sort by position
  if (properties.formFields.length > 0) {
    // Collect all text nodes for label detection
    const textNodes = allNodes.filter(n => n.type === 'TEXT' && n.characters);
    
    // Find labels for each field
    properties.formFields.forEach(field => {
      const fieldNode = allNodes.find(n => n.elementId === field.id);
      if (fieldNode) {
        field.label = findNearbyText(fieldNode, textNodes);
        field.metadata.hasLabel = !!field.label;
      }
    });
    
    // Group fields by parent container
    const fieldGroups = {};
    properties.formFields.forEach(field => {
      const parentId = field.parentContainerId || 'root';
      if (!fieldGroups[parentId]) {
        fieldGroups[parentId] = {
          containerId: parentId,
          containerName: field.parentContainerName || 'Root',
          fields: []
        };
      }
      fieldGroups[parentId].fields.push(field);
    });
    
    // Store field groups
    properties.fieldGroups = Object.values(fieldGroups);
    
    // Sort fields by Y position, then X position
    properties.formFields.sort((a, b) => {
      const posA = a.properties.position;
      const posB = b.properties.position;
      if (!posA || !posB) return 0;
      
      // Sort by Y first (top to bottom)
      if (Math.abs(posA.y - posB.y) > 5) {
        return posA.y - posB.y;
      }
      // Then by X (left to right)
      return posA.x - posB.x;
    });
    
    // Calculate aggregate field metrics
    const fieldMetrics = {
      averageBorderRadius: 0,
      averageHeight: 0,
      averageWidth: 0,
      commonBorderColor: null,
      commonBackgroundColor: null
    };
    
    let totalBorderRadius = 0;
    let borderRadiusCount = 0;
    const borderColors = {};
    const bgColors = {};
    
    properties.formFields.forEach(field => {
      if (field.properties.styling.borderRadius) {
        totalBorderRadius += field.properties.styling.borderRadius;
        borderRadiusCount++;
      }
      
      if (field.properties.dimensions) {
        fieldMetrics.averageHeight += field.properties.dimensions.height || 0;
        fieldMetrics.averageWidth += field.properties.dimensions.width || 0;
      }
      
      // Track color frequencies
      const borderColor = field.properties.styling.borderColor;
      if (borderColor) {
        borderColors[borderColor] = (borderColors[borderColor] || 0) + 1;
      }
      
      const bgColor = field.properties.styling.backgroundColor;
      if (bgColor) {
        bgColors[bgColor] = (bgColors[bgColor] || 0) + 1;
      }
    });
    
    // Calculate averages
    const fieldCount = properties.formFields.length;
    fieldMetrics.averageBorderRadius = borderRadiusCount > 0 ? totalBorderRadius / borderRadiusCount : 0;
    fieldMetrics.averageHeight = fieldMetrics.averageHeight / fieldCount;
    fieldMetrics.averageWidth = fieldMetrics.averageWidth / fieldCount;
    
    // Find most common colors
    fieldMetrics.commonBorderColor = Object.keys(borderColors).reduce((a, b) => 
      borderColors[a] > borderColors[b] ? a : b, null);
    fieldMetrics.commonBackgroundColor = Object.keys(bgColors).reduce((a, b) => 
      bgColors[a] > bgColors[b] ? a : b, null);
    
    properties.fieldMetrics = fieldMetrics;
  } else {
    // No fields detected
    properties.formFields = null;
    console.log('No fields detected in Figma—interesting design!');
  }
  
  // Calculate spacing relationships between sibling elements
  properties.spacingRelationships = calculateSpacingRelationships(properties.elements);
  
  // Detect screen type
  properties.screenType = detectScreenType(properties);
  
  return properties;
}

// Compare individual field properties and calculate differences
function compareFieldProperties(figmaField, detectedField) {
  const differences = [];
  const scores = {
    position: 1,
    dimensions: 1,
    style: 1,
    content: 1
  };
  
  // 1. Position comparison
  const figmaPos = figmaField.properties?.position || {};
  const detectedPos = detectedField.bounds || {};
  
  if (figmaPos.x !== undefined && detectedPos.x !== undefined) {
    const xDiff = Math.abs(figmaPos.x - detectedPos.x);
    const yDiff = Math.abs(figmaPos.y - detectedPos.y);
    
    if (xDiff > 5 || yDiff > 5) {
      differences.push({
        property: 'position',
        expected: `(${figmaPos.x}, ${figmaPos.y})`,
        detected: `(${detectedPos.x}, ${detectedPos.y})`,
        difference: `Shifted by ${xDiff}px horizontally, ${yDiff}px vertically`,
        severity: (xDiff > 20 || yDiff > 20) ? 'major' : 'minor'
      });
      
      // Score based on deviation
      scores.position = Math.max(0, 1 - (xDiff + yDiff) / 100);
    }
  }
  
  // 2. Dimensions comparison
  const figmaDims = figmaField.properties?.dimensions || {};
  const detectedDims = detectedField.bounds || {};
  
  if (figmaDims.width && detectedDims.width) {
    const widthDiff = Math.abs(figmaDims.width - detectedDims.width);
    const heightDiff = Math.abs(figmaDims.height - detectedDims.height);
    
    if (widthDiff > 5 || heightDiff > 5) {
      differences.push({
        property: 'dimensions',
        expected: `${figmaDims.width}x${figmaDims.height}`,
        detected: `${detectedDims.width}x${detectedDims.height}`,
        difference: `Width diff: ${widthDiff}px, Height diff: ${heightDiff}px`,
        severity: (widthDiff > 20 || heightDiff > 20) ? 'major' : 'minor'
      });
      
      scores.dimensions = Math.max(0, 1 - (widthDiff + heightDiff) / (figmaDims.width + figmaDims.height));
    }
  }
  
  // 3. Style comparison
  const figmaStyle = figmaField.properties?.styling || {};
  const detectedStyle = detectedField.properties || {};
  
  // Background color
  if (figmaStyle.backgroundColor && detectedStyle.backgroundColor) {
    if (figmaStyle.backgroundColor !== detectedStyle.backgroundColor) {
      differences.push({
        property: 'backgroundColor',
        expected: figmaStyle.backgroundColor,
        detected: detectedStyle.backgroundColor,
        difference: `Color mismatch`,
        severity: 'minor'
      });
      scores.style *= 0.8;
    }
  }
  
  // Border
  if (figmaStyle.borderColor !== 'none' || detectedStyle.hasBorder) {
    if ((figmaStyle.borderColor === 'none' && detectedStyle.hasBorder) ||
        (figmaStyle.borderColor !== 'none' && !detectedStyle.hasBorder)) {
      differences.push({
        property: 'border',
        expected: figmaStyle.borderColor !== 'none' ? 'Has border' : 'No border',
        detected: detectedStyle.hasBorder ? 'Has border' : 'No border',
        difference: 'Border presence mismatch',
        severity: 'minor'
      });
      scores.style *= 0.9;
    }
  }
  
  // Border radius
  if (figmaStyle.borderRadius !== undefined && detectedStyle.borderRadius !== undefined) {
    const radiusDiff = Math.abs(figmaStyle.borderRadius - detectedStyle.borderRadius);
    if (radiusDiff > 2) {
      differences.push({
        property: 'borderRadius',
        expected: `${figmaStyle.borderRadius}px`,
        detected: `${detectedStyle.borderRadius}px`,
        difference: `Radius differs by ${radiusDiff}px`,
        severity: radiusDiff > 5 ? 'minor' : 'trivial'
      });
      scores.style *= (1 - radiusDiff / 20);
    }
  }
  
  // 4. Content comparison (placeholder, label, button text)
  if (figmaField.type === 'button' && detectedStyle.buttonText) {
    const expectedText = figmaField.name || figmaField.label || '';
    if (expectedText && detectedStyle.buttonText && 
        expectedText.toLowerCase() !== detectedStyle.buttonText.toLowerCase()) {
      differences.push({
        property: 'buttonText',
        expected: expectedText,
        detected: detectedStyle.buttonText,
        difference: 'Button text mismatch',
        severity: 'major'
      });
      scores.content = 0.5;
    }
  }
  
  if (figmaField.placeholder && detectedStyle.placeholderText) {
    if (figmaField.placeholder.toLowerCase() !== detectedStyle.placeholderText.toLowerCase()) {
      differences.push({
        property: 'placeholder',
        expected: figmaField.placeholder,
        detected: detectedStyle.placeholderText,
        difference: 'Placeholder text mismatch',
        severity: 'minor'
      });
      scores.content *= 0.8;
    }
  }
  
  // Calculate overall score
  const overallScore = (scores.position + scores.dimensions + scores.style + scores.content) / 4;
  
  return {
    fieldName: figmaField.name,
    fieldType: figmaField.type,
    differences: differences,
    scores: scores,
    overallScore: overallScore,
    matchQuality: overallScore > 0.9 ? 'excellent' : 
                  overallScore > 0.7 ? 'good' : 
                  overallScore > 0.5 ? 'fair' : 'poor'
  };
}

// Map Figma fields to AI-detected fields
function mapFieldsToDetected(figmaFields, detectedFields, screenDimensions) {
  if (!figmaFields || !detectedFields || figmaFields.length === 0 || detectedFields.length === 0) {
    return {
      mappings: [],
      unmatchedFigma: figmaFields || [],
      unmatchedDetected: detectedFields || [],
      overallScore: 0
    };
  }
  
  const mappings = [];
  const usedDetectedIndices = new Set();
  
  // Calculate position tolerance based on screen dimensions
  const positionToleranceX = screenDimensions ? screenDimensions.width * 0.1 : 50; // 10% of width
  const positionToleranceY = screenDimensions ? screenDimensions.height * 0.05 : 30; // 5% of height
  
  // For each Figma field, find the best matching detected field
  figmaFields.forEach((figmaField, figmaIndex) => {
    let bestMatch = null;
    let bestScore = 0;
    let bestDetectedIndex = -1;
    
    detectedFields.forEach((detectedField, detectedIndex) => {
      // Skip if already matched
      if (usedDetectedIndices.has(detectedIndex)) return;
      
      // Calculate match score based on multiple factors
      let score = 0;
      const scoreDetails = {
        position: 0,
        type: 0,
        dimensions: 0,
        style: 0
      };
      
      // 1. Position matching (40% weight)
      const figmaPos = figmaField.properties?.position || {};
      const detectedPos = detectedField.bounds || {};
      
      if (figmaPos.x !== undefined && detectedPos.x !== undefined) {
        const xDiff = Math.abs(figmaPos.x - detectedPos.x);
        const yDiff = Math.abs(figmaPos.y - detectedPos.y);
        
        if (xDiff <= positionToleranceX && yDiff <= positionToleranceY) {
          // Calculate position score based on proximity
          const xScore = 1 - (xDiff / positionToleranceX);
          const yScore = 1 - (yDiff / positionToleranceY);
          scoreDetails.position = (xScore + yScore) / 2 * 0.4;
          score += scoreDetails.position;
        }
      }
      
      // 2. Type matching (30% weight)
      if (figmaField.type && detectedField.type) {
        // Direct type match
        if (figmaField.type === detectedField.type) {
          scoreDetails.type = 0.3;
        }
        // Compatible types
        else if (
          (figmaField.type === 'input' && ['input', 'email', 'password', 'text'].includes(detectedField.type)) ||
          (figmaField.type === 'button' && detectedField.type === 'button')
        ) {
          scoreDetails.type = 0.2;
        }
        score += scoreDetails.type;
      }
      
      // 3. Dimension matching (20% weight)
      const figmaDims = figmaField.properties?.dimensions || {};
      const detectedDims = detectedField.bounds || {};
      
      if (figmaDims.width && detectedDims.width) {
        const widthRatio = Math.min(figmaDims.width, detectedDims.width) / 
                          Math.max(figmaDims.width, detectedDims.width);
        const heightRatio = Math.min(figmaDims.height, detectedDims.height) / 
                           Math.max(figmaDims.height, detectedDims.height);
        
        // Accept if dimensions are within 20% of each other
        if (widthRatio > 0.8 && heightRatio > 0.8) {
          scoreDetails.dimensions = ((widthRatio + heightRatio) / 2 - 0.8) * 0.2 / 0.2;
          score += scoreDetails.dimensions;
        }
      }
      
      // 4. Style matching (10% weight)
      const figmaStyle = figmaField.properties?.styling || {};
      const detectedStyle = detectedField.properties || {};
      
      let styleMatches = 0;
      let styleChecks = 0;
      
      // Check border
      if (figmaStyle.borderColor && detectedStyle.borderColor) {
        styleChecks++;
        if (figmaStyle.borderColor === detectedStyle.borderColor || 
            (figmaStyle.borderColor !== 'none' && detectedStyle.hasBorder)) {
          styleMatches++;
        }
      }
      
      // Check border radius
      if (figmaStyle.borderRadius !== undefined && detectedStyle.borderRadius !== undefined) {
        styleChecks++;
        if (Math.abs(figmaStyle.borderRadius - detectedStyle.borderRadius) < 5) {
          styleMatches++;
        }
      }
      
      if (styleChecks > 0) {
        scoreDetails.style = (styleMatches / styleChecks) * 0.1;
        score += scoreDetails.style;
      }
      
      // Update best match if this is better
      if (score > bestScore && score > 0.3) { // Minimum threshold of 30%
        bestScore = score;
        bestMatch = {
          figmaField: figmaField,
          figmaIndex: figmaIndex,
          detectedField: detectedField,
          detectedIndex: detectedIndex,
          matchScore: score,
          scoreDetails: scoreDetails,
          positionDiff: {
            x: Math.abs((figmaPos.x || 0) - (detectedPos.x || 0)),
            y: Math.abs((figmaPos.y || 0) - (detectedPos.y || 0))
          }
        };
        bestDetectedIndex = detectedIndex;
      }
    });
    
    // Add the best match if found
    if (bestMatch) {
      // Perform detailed field comparison
      const fieldComparison = compareFieldProperties(
        bestMatch.figmaField,
        bestMatch.detectedField
      );
      bestMatch.comparison = fieldComparison;
      
      mappings.push(bestMatch);
      usedDetectedIndices.add(bestDetectedIndex);
    }
  });
  
  // Find unmatched fields
  const matchedFigmaIndices = new Set(mappings.map(m => m.figmaIndex));
  const unmatchedFigma = figmaFields.filter((_, index) => !matchedFigmaIndices.has(index));
  const unmatchedDetected = detectedFields.filter((_, index) => !usedDetectedIndices.has(index));
  
  // Calculate overall score
  const overallScore = figmaFields.length > 0 ? 
    (mappings.reduce((sum, m) => sum + m.matchScore, 0) / figmaFields.length) : 0;
  
  return {
    mappings: mappings,
    unmatchedFigma: unmatchedFigma,
    unmatchedDetected: unmatchedDetected,
    overallScore: overallScore,
    summary: {
      totalFigmaFields: figmaFields.length,
      totalDetectedFields: detectedFields.length,
      successfulMatches: mappings.length,
      matchRate: figmaFields.length > 0 ? (mappings.length / figmaFields.length) : 0
    }
  };
}

// Detect screen type based on form fields and content patterns
function detectScreenType(properties) {
  const screenTypeInfo = {
    type: 'unknown',
    confidence: 0,
    indicators: []
  };
  
  // Check if there are form fields
  if (!properties.formFields || properties.formFields.length === 0) {
    // No form fields, could be display screen
    screenTypeInfo.type = 'display';
    screenTypeInfo.confidence = 0.6;
    screenTypeInfo.indicators.push('No form fields detected');
    return screenTypeInfo;
  }
  
  const fieldCount = properties.formFields.length;
  const fieldNames = properties.formFields.map(f => f.name.toLowerCase()).join(' ');
  const fieldLabels = properties.formFields.map(f => (f.label || '').toLowerCase()).filter(l => l).join(' ');
  const allFieldText = fieldNames + ' ' + fieldLabels;
  
  // Pattern matching for different screen types
  const patterns = {
    login: {
      keywords: ['login', 'signin', 'sign in', 'email', 'password', 'username', 'remember'],
      fieldRange: [2, 4], // typically 2-4 fields (username/email, password, maybe remember me)
      buttonPatterns: ['login', 'sign in', 'signin', 'submit']
    },
    register: {
      keywords: ['register', 'signup', 'sign up', 'create account', 'email', 'password', 'confirm', 'name', 'username'],
      fieldRange: [3, 8], // typically more fields than login
      buttonPatterns: ['register', 'sign up', 'signup', 'create', 'submit']
    },
    profile: {
      keywords: ['profile', 'account', 'settings', 'name', 'email', 'bio', 'avatar', 'picture'],
      fieldRange: [2, 10],
      buttonPatterns: ['save', 'update', 'edit', 'change']
    },
    search: {
      keywords: ['search', 'find', 'query', 'filter', 'results'],
      fieldRange: [1, 5],
      buttonPatterns: ['search', 'find', 'go', 'filter']
    },
    contact: {
      keywords: ['contact', 'message', 'email', 'subject', 'inquiry', 'support'],
      fieldRange: [3, 6],
      buttonPatterns: ['send', 'submit', 'contact']
    },
    checkout: {
      keywords: ['checkout', 'payment', 'card', 'billing', 'shipping', 'address', 'cvv'],
      fieldRange: [5, 15],
      buttonPatterns: ['pay', 'checkout', 'purchase', 'buy', 'order']
    }
  };
  
  let bestMatch = null;
  let highestScore = 0;
  
  // Check each pattern
  for (const [screenType, pattern] of Object.entries(patterns)) {
    let score = 0;
    const matchedIndicators = [];
    
    // Check field count
    if (fieldCount >= pattern.fieldRange[0] && fieldCount <= pattern.fieldRange[1]) {
      score += 0.3;
      matchedIndicators.push(`Field count (${fieldCount}) matches expected range`);
    }
    
    // Check keywords
    const keywordMatches = pattern.keywords.filter(keyword => 
      allFieldText.includes(keyword)
    );
    if (keywordMatches.length > 0) {
      score += 0.4 * (keywordMatches.length / pattern.keywords.length);
      matchedIndicators.push(`Keywords found: ${keywordMatches.join(', ')}`);
    }
    
    // Check button patterns
    const buttons = properties.formFields.filter(f => f.type === 'button');
    const buttonText = buttons.map(b => b.name.toLowerCase()).join(' ');
    const buttonMatches = pattern.buttonPatterns.filter(btnPattern => 
      buttonText.includes(btnPattern)
    );
    if (buttonMatches.length > 0) {
      score += 0.3;
      matchedIndicators.push(`Button patterns: ${buttonMatches.join(', ')}`);
    }
    
    if (score > highestScore) {
      highestScore = score;
      bestMatch = {
        type: screenType,
        confidence: score,
        indicators: matchedIndicators
      };
    }
  }
  
  // If we have a good match, return it
  if (bestMatch && bestMatch.confidence >= 0.5) {
    return bestMatch;
  }
  
  // Default to form screen if we have fields but couldn't identify specific type
  return {
    type: 'form',
    confidence: 0.4,
    indicators: [`Generic form with ${fieldCount} fields`]
  };
}

// Helper function to calculate spacing between elements
function calculateSpacingRelationships(elements) {
  const relationships = [];
  
  // Group elements by parent to find siblings
  const elementsByParent = {};
  elements.forEach(element => {
    const parentId = element.parentId || 'root';
    if (!elementsByParent[parentId]) {
      elementsByParent[parentId] = [];
    }
    elementsByParent[parentId].push(element);
  });
  
  // Calculate spacing between siblings
  Object.keys(elementsByParent).forEach(parentId => {
    const siblings = elementsByParent[parentId];
    if (siblings.length > 1) {
      // Sort siblings by position
      siblings.sort((a, b) => {
        if (!a.properties.position || !b.properties.position) return 0;
        // Sort by Y first, then X
        if (Math.abs(a.properties.position.y - b.properties.position.y) > 5) {
          return a.properties.position.y - b.properties.position.y;
        }
        return a.properties.position.x - b.properties.position.x;
      });
      
      // Calculate spacing between consecutive siblings
      for (let i = 0; i < siblings.length - 1; i++) {
        const current = siblings[i];
        const next = siblings[i + 1];
        
        if (current.properties.position && next.properties.position) {
          const horizontalGap = next.properties.position.x - 
            (current.properties.position.x + current.properties.position.width);
          const verticalGap = next.properties.position.y - 
            (current.properties.position.y + current.properties.position.height);
          
          relationships.push({
            from: current.id,
            to: next.id,
            horizontalGap: Math.max(0, horizontalGap),
            verticalGap: Math.max(0, verticalGap),
            type: Math.abs(verticalGap) > Math.abs(horizontalGap) ? 'vertical' : 'horizontal'
          });
        }
      }
    }
  });
  
  return relationships;
}

// Analyze screenshot to detect comprehensive UI properties
async function analyzeScreenshot(screenshotPath) {
  try {
    const metadata = await sharp(screenshotPath).metadata();
    console.log('Screenshot dimensions:', metadata.width, 'x', metadata.height);
    
    // Extract colors using existing advanced method
    const colors = await extractDominantColors(screenshotPath);
    
    // Detect UI elements using computer vision techniques
    const uiElements = await detectUIElements(screenshotPath, metadata);
    
    // Analyze typography regions
    const textRegions = await detectTextRegions(screenshotPath, metadata);
    
    // Calculate spacing between detected elements
    const spacingAnalysis = calculateDetectedSpacing(uiElements);
    
    // Detect borders and visual separators
    const borderAnalysis = await detectBorders(screenshotPath, metadata);
    
    // Analyze layout patterns
    const layoutAnalysis = analyzeLayoutPatterns(uiElements);
    
    return {
      colors: colors.palette.slice(0, 10).map((color, index) => ({
        property: index === 0 ? 'dominant' : `color_${index}`,
        hex: color.hex,
        frequency: color.frequency,
        importance: color.importance
      })),
      dimensions: {
        width: metadata.width,
        height: metadata.height
      },
      elements: uiElements,
      textRegions: textRegions,
      spacing: spacingAnalysis,
      borders: borderAnalysis,
      layout: layoutAnalysis,
      analysis: {
        totalElements: uiElements.length,
        textElements: textRegions.length,
        averageSpacing: spacingAnalysis.averageGap,
        layoutComplexity: layoutAnalysis.complexity
      }
    };
  } catch (error) {
    console.error('Screenshot analysis error:', error);
    // Fallback to basic analysis
    const metadata = await sharp(screenshotPath).metadata();
    const colors = await extractDominantColors(screenshotPath);
    
    return {
      colors: colors.palette.slice(0, 10).map((color, index) => ({
        property: index === 0 ? 'dominant' : `color_${index}`,
        hex: color.hex
      })),
      dimensions: {
        width: metadata.width,
        height: metadata.height
      },
      elements: [],
      error: 'Advanced analysis failed, using basic color analysis'
    };
  }
}

// Detect UI elements using edge detection and contour analysis
async function detectUIElements(imagePath, metadata) {
  const elements = [];
  
  try {
    // Convert to grayscale and apply edge detection
    const edgeBuffer = await sharp(imagePath)
      .greyscale()
      .convolve({
        width: 3,
        height: 3,
        kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] // Laplacian edge detection
      })
      .raw()
      .toBuffer();
    
    // Apply Gaussian blur to reduce noise
    const blurredBuffer = await sharp(imagePath)
      .greyscale()
      .blur(1)
      .raw()
      .toBuffer();
    
    // Find contours using a simplified approach
    const contours = findContours(edgeBuffer, metadata.width, metadata.height);
    
    // Filter and process contours into UI elements
    let elementId = 0;
    contours.forEach(contour => {
      // Filter out very small or very large areas
      const area = contour.width * contour.height;
      const minArea = 100; // At least 10x10 pixels
      const maxArea = (metadata.width * metadata.height) * 0.8; // Max 80% of screen
      
      if (area >= minArea && area <= maxArea && contour.width > 5 && contour.height > 5) {
        elements.push({
          id: `detected_element_${elementId++}`,
          type: 'UI_ELEMENT',
          bounds: {
            x: contour.x,
            y: contour.y,
            width: contour.width,
            height: contour.height
          },
          area: area,
          aspectRatio: contour.width / contour.height,
          confidence: calculateElementConfidence(contour, metadata)
        });
      }
    });
    
    // Merge overlapping elements
    const mergedElements = mergeOverlappingElements(elements);
    
    // Sort by confidence and size
    return mergedElements
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 50); // Limit to top 50 elements
      
  } catch (error) {
    console.error('UI element detection error:', error);
    return [];
  }
}

// Simple contour detection algorithm
function findContours(edgeBuffer, width, height) {
  const contours = [];
  const visited = new Array(width * height).fill(false);
  const threshold = 50; // Edge strength threshold
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      
      if (!visited[idx] && edgeBuffer[idx] > threshold) {
        const contour = traceContour(edgeBuffer, visited, x, y, width, height, threshold);
        if (contour && contour.points.length > 10) { // Minimum contour size
          contours.push({
            x: contour.minX,
            y: contour.minY,
            width: contour.maxX - contour.minX,
            height: contour.maxY - contour.minY,
            points: contour.points
          });
        }
      }
    }
  }
  
  return contours;
}

// Trace contour using flood fill
function traceContour(edgeBuffer, visited, startX, startY, width, height, threshold) {
  const points = [];
  const stack = [{x: startX, y: startY}];
  let minX = width, maxX = 0, minY = height, maxY = 0;
  
  while (stack.length > 0 && points.length < 1000) { // Limit contour size
    const {x, y} = stack.pop();
    const idx = y * width + x;
    
    if (x < 0 || x >= width || y < 0 || y >= height || 
        visited[idx] || edgeBuffer[idx] <= threshold) {
      continue;
    }
    
    visited[idx] = true;
    points.push({x, y});
    
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    
    // Check 8 neighbors
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx !== 0 || dy !== 0) {
          stack.push({x: x + dx, y: y + dy});
        }
      }
    }
  }
  
  return points.length > 0 ? {points, minX, maxX, minY, maxY} : null;
}

// Calculate confidence score for detected element
function calculateElementConfidence(contour, metadata) {
  const area = contour.width * contour.height;
  const screenArea = metadata.width * metadata.height;
  const areaRatio = area / screenArea;
  
  // Factors affecting confidence
  const sizeScore = areaRatio > 0.001 && areaRatio < 0.5 ? 1 : 0.5; // Good size range
  const aspectScore = contour.width / contour.height > 0.1 && contour.width / contour.height < 10 ? 1 : 0.5; // Reasonable aspect ratio
  const shapeScore = Math.min(contour.width, contour.height) > 10 ? 1 : 0.5; // Not too thin
  
  return (sizeScore + aspectScore + shapeScore) / 3;
}

// Merge overlapping UI elements
function mergeOverlappingElements(elements) {
  const merged = [];
  const processed = new Set();
  
  for (let i = 0; i < elements.length; i++) {
    if (processed.has(i)) continue;
    
    let currentElement = {...elements[i]};
    processed.add(i);
    
    // Find overlapping elements
    for (let j = i + 1; j < elements.length; j++) {
      if (processed.has(j)) continue;
      
      if (elementsOverlap(currentElement.bounds, elements[j].bounds)) {
        // Merge elements
        const merged_bounds = mergeBounds(currentElement.bounds, elements[j].bounds);
        currentElement = {
          ...currentElement,
          bounds: merged_bounds,
          area: merged_bounds.width * merged_bounds.height,
          confidence: Math.max(currentElement.confidence, elements[j].confidence)
        };
        processed.add(j);
      }
    }
    
    merged.push(currentElement);
  }
  
  return merged;
}

// Check if two elements overlap
function elementsOverlap(bounds1, bounds2) {
  const overlap_x = Math.max(0, Math.min(bounds1.x + bounds1.width, bounds2.x + bounds2.width) - 
                              Math.max(bounds1.x, bounds2.x));
  const overlap_y = Math.max(0, Math.min(bounds1.y + bounds1.height, bounds2.y + bounds2.height) - 
                              Math.max(bounds1.y, bounds2.y));
  
  const overlap_area = overlap_x * overlap_y;
  const area1 = bounds1.width * bounds1.height;
  const area2 = bounds2.width * bounds2.height;
  
  // Elements overlap if overlap is more than 30% of either element
  return overlap_area > 0.3 * Math.min(area1, area2);
}

// Merge two bounding rectangles
function mergeBounds(bounds1, bounds2) {
  const minX = Math.min(bounds1.x, bounds2.x);
  const minY = Math.min(bounds1.y, bounds2.y);
  const maxX = Math.max(bounds1.x + bounds1.width, bounds2.x + bounds2.width);
  const maxY = Math.max(bounds1.y + bounds1.height, bounds2.y + bounds2.height);
  
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

// Detect text regions using morphological operations
async function detectTextRegions(imagePath, metadata) {
  try {
    // Apply morphological operations to detect text-like regions
    const textBuffer = await sharp(imagePath)
      .greyscale()
      .threshold(128) // Binarize
      .raw()
      .toBuffer();
    
    // Find horizontal and vertical patterns that suggest text
    const textRegions = [];
    const blockSize = 20; // Size of blocks to analyze
    
    for (let y = 0; y < metadata.height - blockSize; y += blockSize) {
      for (let x = 0; x < metadata.width - blockSize; x += blockSize) {
        const textScore = analyzeTextBlock(textBuffer, x, y, blockSize, metadata.width);
        
        if (textScore > 0.3) { // Threshold for text detection
          textRegions.push({
            x: x,
            y: y,
            width: blockSize,
            height: blockSize,
            confidence: textScore,
            type: 'TEXT_REGION'
          });
        }
      }
    }
    
    return mergeTextRegions(textRegions);
  } catch (error) {
    console.error('Text detection error:', error);
    return [];
  }
}

// Analyze a block for text-like patterns
function analyzeTextBlock(buffer, startX, startY, blockSize, imageWidth) {
  let transitions = 0;
  let totalPixels = 0;
  
  // Count horizontal transitions (characteristic of text)
  for (let y = startY; y < startY + blockSize; y++) {
    let lastPixel = null;
    for (let x = startX; x < startX + blockSize; x++) {
      const idx = y * imageWidth + x;
      const pixel = buffer[idx];
      
      if (lastPixel !== null && Math.abs(pixel - lastPixel) > 100) {
        transitions++;
      }
      lastPixel = pixel;
      totalPixels++;
    }
  }
  
  // Text regions typically have many transitions
  return transitions / (totalPixels / blockSize);
}

// Merge nearby text regions
function mergeTextRegions(regions) {
  const merged = [];
  const processed = new Set();
  
  for (let i = 0; i < regions.length; i++) {
    if (processed.has(i)) continue;
    
    let currentRegion = {...regions[i]};
    processed.add(i);
    
    // Find nearby regions to merge
    for (let j = i + 1; j < regions.length; j++) {
      if (processed.has(j)) continue;
      
      const distance = Math.sqrt(
        Math.pow(currentRegion.x - regions[j].x, 2) + 
        Math.pow(currentRegion.y - regions[j].y, 2)
      );
      
      if (distance < 30) { // Merge if within 30 pixels
        currentRegion = {
          ...currentRegion,
          ...mergeBounds(currentRegion, regions[j]),
          confidence: Math.max(currentRegion.confidence, regions[j].confidence)
        };
        processed.add(j);
      }
    }
    
    merged.push(currentRegion);
  }
  
  return merged;
}

// Calculate spacing between detected elements
function calculateDetectedSpacing(elements) {
  if (elements.length < 2) {
    return {
      averageGap: 0,
      horizontalGaps: [],
      verticalGaps: [],
      spacingPatterns: []
    };
  }
  
  const horizontalGaps = [];
  const verticalGaps = [];
  const spacingPatterns = [];
  
  // Sort elements by position
  const sortedByY = [...elements].sort((a, b) => a.bounds.y - b.bounds.y);
  const sortedByX = [...elements].sort((a, b) => a.bounds.x - b.bounds.x);
  
  // Calculate vertical gaps (between elements stacked vertically)
  for (let i = 0; i < sortedByY.length - 1; i++) {
    const current = sortedByY[i];
    const next = sortedByY[i + 1];
    
    // Check if elements are roughly aligned horizontally
    const horizontalOverlap = Math.max(0, 
      Math.min(current.bounds.x + current.bounds.width, next.bounds.x + next.bounds.width) - 
      Math.max(current.bounds.x, next.bounds.x)
    );
    
    if (horizontalOverlap > 10) { // Some horizontal overlap suggests vertical stacking
      const gap = next.bounds.y - (current.bounds.y + current.bounds.height);
      if (gap >= 0 && gap < 200) { // Reasonable gap size
        verticalGaps.push(gap);
        spacingPatterns.push({
          type: 'vertical',
          from: current.id,
          to: next.id,
          gap: gap
        });
      }
    }
  }
  
  // Calculate horizontal gaps (between elements side by side)
  for (let i = 0; i < sortedByX.length - 1; i++) {
    const current = sortedByX[i];
    const next = sortedByX[i + 1];
    
    // Check if elements are roughly aligned vertically
    const verticalOverlap = Math.max(0, 
      Math.min(current.bounds.y + current.bounds.height, next.bounds.y + next.bounds.height) - 
      Math.max(current.bounds.y, next.bounds.y)
    );
    
    if (verticalOverlap > 10) { // Some vertical overlap suggests horizontal alignment
      const gap = next.bounds.x - (current.bounds.x + current.bounds.width);
      if (gap >= 0 && gap < 200) { // Reasonable gap size
        horizontalGaps.push(gap);
        spacingPatterns.push({
          type: 'horizontal',
          from: current.id,
          to: next.id,
          gap: gap
        });
      }
    }
  }
  
  const allGaps = [...horizontalGaps, ...verticalGaps];
  const averageGap = allGaps.length > 0 ? allGaps.reduce((sum, gap) => sum + gap, 0) / allGaps.length : 0;
  
  return {
    averageGap: Math.round(averageGap),
    horizontalGaps,
    verticalGaps,
    spacingPatterns,
    stats: {
      totalGaps: allGaps.length,
      minGap: allGaps.length > 0 ? Math.min(...allGaps) : 0,
      maxGap: allGaps.length > 0 ? Math.max(...allGaps) : 0
    }
  };
}

// Detect borders and visual separators
async function detectBorders(imagePath, metadata) {
  try {
    // Use Sobel edge detection for better border detection
    const borderBuffer = await sharp(imagePath)
      .greyscale()
      .convolve({
        width: 3,
        height: 3,
        kernel: [-1, 0, 1, -2, 0, 2, -1, 0, 1] // Sobel X
      })
      .raw()
      .toBuffer();
    
    const borders = [];
    const threshold = 30;
    
    // Detect horizontal lines
    for (let y = 10; y < metadata.height - 10; y += 5) {
      let lineStart = null;
      let lineLength = 0;
      
      for (let x = 0; x < metadata.width; x++) {
        const idx = y * metadata.width + x;
        
        if (borderBuffer[idx] > threshold) {
          if (lineStart === null) lineStart = x;
          lineLength++;
        } else {
          if (lineLength > 50) { // Minimum line length
            borders.push({
              type: 'horizontal_line',
              x: lineStart,
              y: y,
              length: lineLength,
              thickness: 1
            });
          }
          lineStart = null;
          lineLength = 0;
        }
      }
    }
    
    return {
      detectedBorders: borders.length,
      borders: borders.slice(0, 20), // Limit results
      hasVisualSeparators: borders.length > 0
    };
  } catch (error) {
    console.error('Border detection error:', error);
    return {
      detectedBorders: 0,
      borders: [],
      hasVisualSeparators: false
    };
  }
}

// Analyze layout patterns in detected elements
function analyzeLayoutPatterns(elements) {
  if (elements.length < 3) {
    return {
      complexity: 'simple',
      patterns: [],
      alignment: 'none'
    };
  }
  
  const patterns = [];
  let complexity = 'simple';
  
  // Analyze alignment patterns
  const leftAligned = findAlignedElements(elements, 'left');
  const rightAligned = findAlignedElements(elements, 'right');
  const centerAligned = findAlignedElements(elements, 'center');
  const topAligned = findAlignedElements(elements, 'top');
  const bottomAligned = findAlignedElements(elements, 'bottom');
  
  if (leftAligned.length > 2) patterns.push({type: 'left_alignment', count: leftAligned.length});
  if (rightAligned.length > 2) patterns.push({type: 'right_alignment', count: rightAligned.length});
  if (centerAligned.length > 2) patterns.push({type: 'center_alignment', count: centerAligned.length});
  if (topAligned.length > 2) patterns.push({type: 'top_alignment', count: topAligned.length});
  if (bottomAligned.length > 2) patterns.push({type: 'bottom_alignment', count: bottomAligned.length});
  
  // Analyze grid patterns
  const gridPattern = detectGridPattern(elements);
  if (gridPattern.isGrid) {
    patterns.push({type: 'grid_layout', rows: gridPattern.rows, cols: gridPattern.cols});
    complexity = 'complex';
  }
  
  // Determine overall complexity
  if (patterns.length > 3) complexity = 'complex';
  else if (patterns.length > 1) complexity = 'moderate';
  
  return {
    complexity,
    patterns,
    alignment: patterns.length > 0 ? patterns[0].type : 'none',
    stats: {
      totalPatterns: patterns.length,
      alignmentScore: patterns.length / elements.length
    }
  };
}

// Find elements aligned to a specific edge
function findAlignedElements(elements, alignmentType) {
  const tolerance = 5; // 5px tolerance
  const aligned = [];
  
  elements.forEach(element => {
    let alignValue;
    switch (alignmentType) {
      case 'left': alignValue = element.bounds.x; break;
      case 'right': alignValue = element.bounds.x + element.bounds.width; break;
      case 'center': alignValue = element.bounds.x + element.bounds.width / 2; break;
      case 'top': alignValue = element.bounds.y; break;
      case 'bottom': alignValue = element.bounds.y + element.bounds.height; break;
      default: return;
    }
    
    // Find other elements with similar alignment
    const similarElements = elements.filter(other => {
      if (other.id === element.id) return false;
      
      let otherAlignValue;
      switch (alignmentType) {
        case 'left': otherAlignValue = other.bounds.x; break;
        case 'right': otherAlignValue = other.bounds.x + other.bounds.width; break;
        case 'center': otherAlignValue = other.bounds.x + other.bounds.width / 2; break;
        case 'top': otherAlignValue = other.bounds.y; break;
        case 'bottom': otherAlignValue = other.bounds.y + other.bounds.height; break;
        default: return false;
      }
      
      return Math.abs(alignValue - otherAlignValue) <= tolerance;
    });
    
    if (similarElements.length > 0) {
      aligned.push(element);
    }
  });
  
  return aligned;
}

// Detect grid layout patterns
function detectGridPattern(elements) {
  if (elements.length < 4) return {isGrid: false};
  
  // Sort elements by position
  const sorted = [...elements].sort((a, b) => {
    if (Math.abs(a.bounds.y - b.bounds.y) < 10) {
      return a.bounds.x - b.bounds.x;
    }
    return a.bounds.y - b.bounds.y;
  });
  
  // Try to detect rows and columns
  const rows = [];
  let currentRow = [];
  let lastY = sorted[0].bounds.y;
  
  sorted.forEach(element => {
    if (Math.abs(element.bounds.y - lastY) < 10) {
      currentRow.push(element);
    } else {
      if (currentRow.length > 0) rows.push(currentRow);
      currentRow = [element];
      lastY = element.bounds.y;
    }
  });
  if (currentRow.length > 0) rows.push(currentRow);
  
  // Check if it's a regular grid
  if (rows.length >= 2) {
    const colCounts = rows.map(row => row.length);
    const avgCols = colCounts.reduce((sum, count) => sum + count, 0) / colCounts.length;
    const isRegular = colCounts.every(count => Math.abs(count - avgCols) <= 1);
    
    if (isRegular) {
      return {
        isGrid: true,
        rows: rows.length,
        cols: Math.round(avgCols)
      };
    }
  }
  
  return {isGrid: false};
}

// Compare Figma properties with detected properties
function compareProperties(figma, detected) {
  const mismatches = [];
  const colorMismatches = [];
  
  // Compare colors with better tolerance
  figma.colors.forEach(figmaColor => {
    // Find the closest matching color
    let closestMatch = null;
    let minDistance = Infinity;
    
    detected.colors.forEach(detectedColor => {
      const distance = colorDistance(figmaColor.value, detectedColor.hex);
      if (distance < minDistance) {
        minDistance = distance;
        closestMatch = detectedColor;
      }
    });
    
    // Color matching thresholds for Delta E 2000
    // Human perception: ΔE < 1 = not perceptible, 1-2 = barely perceptible, 2-10 = perceptible, > 10 = different colors
    const EXACT_MATCH = 1.0;   // Not perceptible by human eye
    const CLOSE_MATCH = 2.3;   // Just noticeable difference
    const POOR_MATCH = 10.0;   // Clearly different colors
    
    if (!closestMatch || minDistance > POOR_MATCH) {
      colorMismatches.push({
        property: figmaColor.property,
        expected: figmaColor.value,
        actual: closestMatch ? closestMatch.hex : 'Not detected',
        severity: 'major',
        distance: minDistance,
        deltaE: minDistance.toFixed(2)
      });
      
      mismatches.push({
        property: `Color: ${figmaColor.property}`,
        expected: figmaColor.value,
        actual: closestMatch ? closestMatch.hex : 'Not detected',
        severity: 'major'
      });
    } else if (minDistance > CLOSE_MATCH) {
      colorMismatches.push({
        property: figmaColor.property,
        expected: figmaColor.value,
        actual: closestMatch.hex,
        severity: 'minor',
        distance: minDistance,
        deltaE: minDistance.toFixed(2)
      });
      
      mismatches.push({
        property: `Color: ${figmaColor.property}`,
        expected: figmaColor.value,
        actual: closestMatch.hex,
        severity: 'minor'
      });
    } else if (minDistance > EXACT_MATCH) {
      // Very close but not exact - might be due to compression or rendering
      colorMismatches.push({
        property: figmaColor.property,
        expected: figmaColor.value,
        actual: closestMatch.hex,
        severity: 'minor',
        distance: minDistance,
        deltaE: minDistance.toFixed(2)
      });
    }
    // If minDistance <= EXACT_MATCH, it's considered a perfect match
  });
  
  // Calculate accuracy
  const totalChecks = figma.colors.length;
  const exactMatches = figma.colors.length - colorMismatches.length;
  const minorMatches = colorMismatches.filter(m => m.severity === 'minor').length;
  const matches = exactMatches + (minorMatches * 0.5); // Minor matches count as half
  const accuracy = totalChecks > 0 ? (matches / totalChecks * 100).toFixed(2) : 100;
  
  // Log for debugging
  console.log('Color comparison summary:');
  console.log('- Total Figma colors:', figma.colors.length);
  console.log('- Total detected colors:', detected.colors.length);
  console.log('- Exact matches:', exactMatches);
  console.log('- Minor mismatches:', minorMatches);
  console.log('- Major mismatches:', colorMismatches.filter(m => m.severity === 'major').length);
  
  // Compare spacing if available
  const spacingMismatches = compareSpacing(figma, detected);
  
  // Compare dimensions
  const dimensionMismatches = compareDimensions(figma, detected);
  
  // Compare typography if available
  const textMismatches = compareTypography(figma, detected);
  
  // Compare layout patterns
  const layoutMismatches = compareLayout(figma, detected);
  
  // Add all mismatches to the main array
  mismatches.push(...spacingMismatches, ...dimensionMismatches, ...textMismatches, ...layoutMismatches);
  
  // Compare form fields if available
  const fieldMismatches = [];
  if (figma.formFields && figma.formFields.length > 0) {
    console.log(`Comparing ${figma.formFields.length} form fields...`);
    
    figma.formFields.forEach(figmaField => {
      const fieldX = figmaField.properties?.position?.x || 0;
      const fieldY = figmaField.properties?.position?.y || 0;
      console.log(`Analyzing field: ${figmaField.type} "${figmaField.name}" at (${fieldX}, ${fieldY})`);
      
      // Check field properties
      if (figmaField.properties) {
        // Check border radius
        if (figmaField.properties.styling?.borderRadius) {
          fieldMismatches.push({
            property: `Field Border Radius: ${figmaField.type}`,
            expected: `${figmaField.properties.styling.borderRadius}px`,
            detected: 'Check visual analysis',
            severity: 'info'
          });
        }
        
        // Check field dimensions
        if (figmaField.properties.dimensions) {
          fieldMismatches.push({
            property: `Field Size: ${figmaField.type}`,
            expected: `${figmaField.properties.dimensions.width}x${figmaField.properties.dimensions.height}`,
            detected: 'Check visual analysis',
            severity: 'info'
          });
        }
        
        // Check field colors
        if (figmaField.properties.styling?.backgroundColor) {
          fieldMismatches.push({
            property: `Field Background: ${figmaField.type}`,
            expected: figmaField.properties.styling.backgroundColor,
            detected: 'Check visual analysis',
            severity: 'info'
          });
        }
      }
    });
    
    mismatches.push(...fieldMismatches);
  }
  
  // Recalculate accuracy including all comparisons
  const totalPropertyChecks = figma.colors.length + 
                      (figma.spacing ? Object.keys(figma.spacing).length : 0) + 
                      (figma.typography.length > 0 ? 3 : 0) + // font, size, weight
                      (figma.dimensions ? 2 : 0); // width, height
                      
  const totalMismatches = mismatches.filter(m => m.severity === 'major').length;
  const allMinorMismatches = mismatches.filter(m => m.severity === 'minor').length;
  const overallAccuracy = totalPropertyChecks > 0 ? 
    ((totalPropertyChecks - totalMismatches - allMinorMismatches * 0.5) / totalPropertyChecks * 100).toFixed(2) : 100;
  
  return {
    accuracy: overallAccuracy,
    mismatches: mismatches,
    colorMismatches: colorMismatches,
    spacingMismatches: spacingMismatches,
    textMismatches: textMismatches,
    sizeMismatches: dimensionMismatches,
    layoutMismatches: layoutMismatches,
    fieldMismatches: fieldMismatches
  };
}

// Compare spacing with configurable tolerance
function compareSpacing(figma, detected) {
  const mismatches = [];
  
  // Define tolerance thresholds
  const SPACING_TOLERANCE = {
    EXACT: 2,    // ±2px
    CLOSE: 5,    // ±5px
    ACCEPTABLE: 10 // ±10px
  };
  
  // Compare padding if available
  if (figma.spacing.padding && detected.spacing) {
    const figmaPadding = figma.spacing.padding;
    
    // Since we can't detect exact padding from screenshot, compare against detected gaps
    if (detected.spacing.averageGap) {
      const avgGap = detected.spacing.averageGap;
      
      // Check if average gap is close to any of the padding values
      const paddingValues = [figmaPadding.top, figmaPadding.right, figmaPadding.bottom, figmaPadding.left];
      const closestPadding = paddingValues.reduce((closest, pad) => {
        return Math.abs(pad - avgGap) < Math.abs(closest - avgGap) ? pad : closest;
      }, paddingValues[0]);
      
      const difference = Math.abs(closestPadding - avgGap);
      
      if (difference > SPACING_TOLERANCE.ACCEPTABLE) {
        mismatches.push({
          property: 'Average Spacing',
          expected: `${closestPadding}px (from padding)`,
          actual: `${avgGap}px`,
          severity: difference > SPACING_TOLERANCE.ACCEPTABLE * 2 ? 'major' : 'minor',
          difference: difference
        });
      }
    }
  }
  
  // Compare gap/item spacing
  if (figma.spacing.gap !== undefined && detected.spacing && detected.spacing.spacingPatterns) {
    const expectedGap = figma.spacing.gap;
    const detectedGaps = detected.spacing.spacingPatterns.map(p => p.gap);
    
    if (detectedGaps.length > 0) {
      // Check how many gaps match the expected value
      const matchingGaps = detectedGaps.filter(gap => 
        Math.abs(gap - expectedGap) <= SPACING_TOLERANCE.CLOSE
      );
      
      const matchRatio = matchingGaps.length / detectedGaps.length;
      
      if (matchRatio < 0.8) { // Less than 80% match
        mismatches.push({
          property: 'Item Spacing Consistency',
          expected: `${expectedGap}px`,
          actual: `Varies: ${Math.min(...detectedGaps)}-${Math.max(...detectedGaps)}px`,
          severity: matchRatio < 0.5 ? 'major' : 'minor',
          details: `${Math.round(matchRatio * 100)}% of gaps match expected value`
        });
      }
    }
  }
  
  // Check spacing consistency between elements
  if (detected.spacing && detected.spacing.spacingPatterns && detected.spacing.spacingPatterns.length > 2) {
    const gaps = detected.spacing.spacingPatterns.map(p => p.gap);
    const avgGap = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    const variance = gaps.reduce((sum, gap) => sum + Math.pow(gap - avgGap, 2), 0) / gaps.length;
    const stdDev = Math.sqrt(variance);
    
    // High standard deviation indicates inconsistent spacing
    if (stdDev > SPACING_TOLERANCE.ACCEPTABLE) {
      mismatches.push({
        property: 'Spacing Consistency',
        expected: 'Consistent spacing',
        actual: `High variance (σ=${stdDev.toFixed(1)}px)`,
        severity: stdDev > SPACING_TOLERANCE.ACCEPTABLE * 2 ? 'major' : 'minor',
        details: `Gaps range from ${Math.min(...gaps)}px to ${Math.max(...gaps)}px`
      });
    }
  }
  
  return mismatches;
}

// Compare dimensions with percentage tolerance
function compareDimensions(figma, detected) {
  const mismatches = [];
  
  // Define tolerance as percentage of expected dimension
  const DIMENSION_TOLERANCE = {
    EXACT: 0.01,    // 1%
    CLOSE: 0.02,    // 2%
    ACCEPTABLE: 0.05 // 5%
  };
  
  if (figma.dimensions && detected.dimensions) {
    // Compare width
    if (figma.dimensions.width && detected.dimensions.width) {
      const widthDiff = Math.abs(figma.dimensions.width - detected.dimensions.width);
      const widthDiffPercent = widthDiff / figma.dimensions.width;
      
      if (widthDiffPercent > DIMENSION_TOLERANCE.ACCEPTABLE) {
        mismatches.push({
          property: 'Width',
          expected: `${figma.dimensions.width}px`,
          actual: `${detected.dimensions.width}px`,
          severity: widthDiffPercent > DIMENSION_TOLERANCE.ACCEPTABLE * 2 ? 'major' : 'minor',
          difference: `${widthDiff}px (${(widthDiffPercent * 100).toFixed(1)}%)`
        });
      }
    }
    
    // Compare height
    if (figma.dimensions.height && detected.dimensions.height) {
      const heightDiff = Math.abs(figma.dimensions.height - detected.dimensions.height);
      const heightDiffPercent = heightDiff / figma.dimensions.height;
      
      if (heightDiffPercent > DIMENSION_TOLERANCE.ACCEPTABLE) {
        mismatches.push({
          property: 'Height',
          expected: `${figma.dimensions.height}px`,
          actual: `${detected.dimensions.height}px`,
          severity: heightDiffPercent > DIMENSION_TOLERANCE.ACCEPTABLE * 2 ? 'major' : 'minor',
          difference: `${heightDiff}px (${(heightDiffPercent * 100).toFixed(1)}%)`
        });
      }
    }
  }
  
  return mismatches;
}

// Compare typography properties
function compareTypography(figma, detected) {
  const mismatches = [];
  
  // We can't detect exact typography from screenshots, but we can check text regions
  if (figma.typography.length > 0 && detected.textRegions) {
    const expectedTextElements = figma.typography.length;
    const detectedTextElements = detected.textRegions.length;
    
    if (Math.abs(expectedTextElements - detectedTextElements) > 2) {
      mismatches.push({
        property: 'Text Elements Count',
        expected: `${expectedTextElements} text elements`,
        actual: `${detectedTextElements} text regions detected`,
        severity: Math.abs(expectedTextElements - detectedTextElements) > 5 ? 'major' : 'minor'
      });
    }
  }
  
  return mismatches;
}

// Compare layout patterns
function compareLayout(figma, detected) {
  const mismatches = [];
  
  // Compare layout mode if available
  if (figma.layout && figma.layout.mode && detected.layout) {
    const figmaLayoutMode = figma.layout.mode;
    const detectedComplexity = detected.layout.complexity;
    
    // Map Figma layout modes to expected complexity
    const expectedComplexity = {
      'HORIZONTAL': 'moderate',
      'VERTICAL': 'moderate',
      'NONE': 'simple'
    };
    
    const expected = expectedComplexity[figmaLayoutMode] || 'moderate';
    
    if (expected !== detectedComplexity && detectedComplexity !== 'unknown') {
      mismatches.push({
        property: 'Layout Complexity',
        expected: `${expected} (${figmaLayoutMode})`,
        actual: detectedComplexity,
        severity: 'minor'
      });
    }
  }
  
  // Check element alignment
  if (detected.layout && detected.layout.patterns) {
    const alignmentPatterns = detected.layout.patterns.filter(p => 
      p.type.includes('alignment')
    );
    
    // If Figma specifies alignment, check if it matches
    if (figma.layout && figma.layout.primaryAxisAlignItems) {
      const expectedAlignment = figma.layout.primaryAxisAlignItems.toLowerCase();
      const hasExpectedAlignment = alignmentPatterns.some(p => 
        p.type.includes(expectedAlignment)
      );
      
      if (!hasExpectedAlignment && alignmentPatterns.length > 0) {
        mismatches.push({
          property: 'Element Alignment',
          expected: expectedAlignment,
          actual: alignmentPatterns[0].type.replace('_alignment', ''),
          severity: 'minor'
        });
      }
    }
  }
  
  // Check grid detection
  if (detected.layout && detected.layout.patterns) {
    const gridPattern = detected.layout.patterns.find(p => p.type === 'grid_layout');
    
    if (gridPattern && figma.layout && figma.layout.mode === 'NONE') {
      mismatches.push({
        property: 'Layout Pattern',
        expected: 'No specific layout',
        actual: `Grid detected (${gridPattern.rows}x${gridPattern.cols})`,
        severity: 'minor',
        details: 'Detected grid pattern where none was expected'
      });
    }
  }
  
  return mismatches;
}

// Create spacing/layout overlay visualization
async function createSpacingOverlay(screenshotPath, detectedProperties, comparison, reportId) {
  try {
    const metadata = await sharp(screenshotPath).metadata();
    const { width, height } = metadata;
    
    // Create a semi-transparent overlay
    const overlay = await sharp({
      create: {
        width: width,
        height: height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    }).png().toBuffer();
    
    // Convert to PNG for manipulation
    const overlayPng = PNG.sync.read(overlay);
    
    // Draw UI element boundaries
    if (detectedProperties.elements) {
      detectedProperties.elements.forEach(element => {
        if (element.bounds) {
          drawElementOutline(overlayPng, element.bounds, width, height, 
            { r: 59, g: 130, b: 246, a: 180 }); // Blue for elements
        }
      });
    }
    
    // Draw spacing indicators
    if (detectedProperties.spacing && detectedProperties.spacing.spacingPatterns) {
      detectedProperties.spacing.spacingPatterns.forEach(pattern => {
        // Find elements by ID
        const fromElement = detectedProperties.elements.find(e => e.id === pattern.from);
        const toElement = detectedProperties.elements.find(e => e.id === pattern.to);
        
        if (fromElement && toElement) {
          drawSpacingIndicator(overlayPng, fromElement.bounds, toElement.bounds, 
            pattern.gap, pattern.type, width, height);
        }
      });
    }
    
    // Draw text region indicators
    if (detectedProperties.textRegions) {
      detectedProperties.textRegions.forEach(region => {
        drawTextRegionIndicator(overlayPng, region, width, height);
      });
    }
    
    // Draw mismatches with different colors based on severity
    if (comparison.spacingMismatches) {
      // Add visual indicators for spacing issues
      comparison.spacingMismatches.forEach((mismatch, index) => {
        if (mismatch.severity === 'major') {
          // Draw attention marker
          drawAttentionMarker(overlayPng, 20, 20 + index * 30, width, height, 
            { r: 239, g: 68, b: 68, a: 200 }); // Red for major issues
        }
      });
    }
    
    // Convert back to buffer
    const overlayBuffer = PNG.sync.write(overlayPng);
    
    // Create the final overlay by compositing over the original screenshot
    const overlayPath = path.join(uploadsDir, `spacing-overlay-${reportId}.png`);
    
    await sharp(screenshotPath)
      .composite([{
        input: overlayBuffer,
        blend: 'over'
      }])
      .toFile(overlayPath);
    
    return `/uploads/${path.basename(overlayPath)}`;
  } catch (error) {
    console.error('Error creating spacing overlay:', error);
    return null;
  }
}

// Draw element outline on PNG
function drawElementOutline(png, bounds, width, height, color) {
  const thickness = 2;
  const { x, y, width: w, height: h } = bounds;
  
  // Draw rectangle outline
  for (let t = 0; t < thickness; t++) {
    // Top line
    for (let px = x; px < x + w && px < width; px++) {
      const idx = ((y + t) * width + px) * 4;
      if (idx >= 0 && idx < png.data.length - 3) {
        png.data[idx] = color.r;
        png.data[idx + 1] = color.g;
        png.data[idx + 2] = color.b;
        png.data[idx + 3] = color.a;
      }
    }
    
    // Bottom line
    for (let px = x; px < x + w && px < width; px++) {
      const idx = ((y + h - 1 - t) * width + px) * 4;
      if (idx >= 0 && idx < png.data.length - 3) {
        png.data[idx] = color.r;
        png.data[idx + 1] = color.g;
        png.data[idx + 2] = color.b;
        png.data[idx + 3] = color.a;
      }
    }
    
    // Left line
    for (let py = y; py < y + h && py < height; py++) {
      const idx = (py * width + x + t) * 4;
      if (idx >= 0 && idx < png.data.length - 3) {
        png.data[idx] = color.r;
        png.data[idx + 1] = color.g;
        png.data[idx + 2] = color.b;
        png.data[idx + 3] = color.a;
      }
    }
    
    // Right line
    for (let py = y; py < y + h && py < height; py++) {
      const idx = (py * width + x + w - 1 - t) * 4;
      if (idx >= 0 && idx < png.data.length - 3) {
        png.data[idx] = color.r;
        png.data[idx + 1] = color.g;
        png.data[idx + 2] = color.b;
        png.data[idx + 3] = color.a;
      }
    }
  }
}

// Draw spacing indicator between elements
function drawSpacingIndicator(png, fromBounds, toBounds, gap, type, width, height) {
  const color = { r: 255, g: 152, b: 0, a: 200 }; // Orange for spacing
  
  if (type === 'horizontal') {
    // Draw horizontal spacing line
    const y = Math.round(fromBounds.y + fromBounds.height / 2);
    const x1 = fromBounds.x + fromBounds.width;
    const x2 = toBounds.x;
    
    // Draw line
    for (let x = x1; x < x2 && x < width; x++) {
      const idx = (y * width + x) * 4;
      if (idx >= 0 && idx < png.data.length - 3) {
        png.data[idx] = color.r;
        png.data[idx + 1] = color.g;
        png.data[idx + 2] = color.b;
        png.data[idx + 3] = color.a;
      }
    }
    
    // Draw gap text
    drawText(png, `${gap}px`, Math.round((x1 + x2) / 2 - 15), y - 10, width, height);
  } else if (type === 'vertical') {
    // Draw vertical spacing line
    const x = Math.round(fromBounds.x + fromBounds.width / 2);
    const y1 = fromBounds.y + fromBounds.height;
    const y2 = toBounds.y;
    
    // Draw line
    for (let y = y1; y < y2 && y < height; y++) {
      const idx = (y * width + x) * 4;
      if (idx >= 0 && idx < png.data.length - 3) {
        png.data[idx] = color.r;
        png.data[idx + 1] = color.g;
        png.data[idx + 2] = color.b;
        png.data[idx + 3] = color.a;
      }
    }
    
    // Draw gap text
    drawText(png, `${gap}px`, x + 5, Math.round((y1 + y2) / 2), width, height);
  }
}

// Draw text region indicator
function drawTextRegionIndicator(png, region, width, height) {
  const color = { r: 76, g: 175, b: 80, a: 150 }; // Green for text regions
  drawElementOutline(png, region, width, height, color);
}

// Draw attention marker for issues
function drawAttentionMarker(png, x, y, width, height, color) {
  const size = 20;
  
  // Draw exclamation mark or circle
  for (let py = y; py < y + size && py < height; py++) {
    for (let px = x; px < x + size && px < width; px++) {
      const dx = px - (x + size / 2);
      const dy = py - (y + size / 2);
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance < size / 2) {
        const idx = (py * width + px) * 4;
        if (idx >= 0 && idx < png.data.length - 3) {
          png.data[idx] = color.r;
          png.data[idx + 1] = color.g;
          png.data[idx + 2] = color.b;
          png.data[idx + 3] = color.a;
        }
      }
    }
  }
}

// Simple text drawing (numbers only for now)
function drawText(png, text, x, y, width, height) {
  // This is a simplified version - in production, you'd use a proper font rendering library
  const color = { r: 255, g: 255, b: 255, a: 255 };
  const bgColor = { r: 0, g: 0, b: 0, a: 200 };
  
  // Draw background rectangle
  const textWidth = text.length * 6;
  const textHeight = 10;
  
  for (let py = y; py < y + textHeight && py < height; py++) {
    for (let px = x; px < x + textWidth && px < width; px++) {
      const idx = (py * width + px) * 4;
      if (idx >= 0 && idx < png.data.length - 3) {
        png.data[idx] = bgColor.r;
        png.data[idx + 1] = bgColor.g;
        png.data[idx + 2] = bgColor.b;
        png.data[idx + 3] = bgColor.a;
      }
    }
  }
}

// Calculate color distance using Delta E 2000 formula
function colorDistance(hex1, hex2) {
  const lab1 = hexToLab(hex1);
  const lab2 = hexToLab(hex2);
  
  if (!lab1 || !lab2) return 999;
  
  return deltaE2000(lab1, lab2);
}

// Convert hex to LAB color space
function hexToLab(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  
  // Convert RGB to XYZ
  let rLinear = rgb.r / 255;
  let gLinear = rgb.g / 255;
  let bLinear = rgb.b / 255;
  
  // Apply gamma correction
  rLinear = rLinear > 0.04045 ? Math.pow((rLinear + 0.055) / 1.055, 2.4) : rLinear / 12.92;
  gLinear = gLinear > 0.04045 ? Math.pow((gLinear + 0.055) / 1.055, 2.4) : gLinear / 12.92;
  bLinear = bLinear > 0.04045 ? Math.pow((bLinear + 0.055) / 1.055, 2.4) : bLinear / 12.92;
  
  // Observer = 2°, Illuminant = D65
  const x = (rLinear * 0.4124564 + gLinear * 0.3575761 + bLinear * 0.1804375) * 100;
  const y = (rLinear * 0.2126729 + gLinear * 0.7151522 + bLinear * 0.0721750) * 100;
  const z = (rLinear * 0.0193339 + gLinear * 0.1191920 + bLinear * 0.9503041) * 100;
  
  // Normalize for D65 illuminant
  const xn = 95.047;
  const yn = 100.000;
  const zn = 108.883;
  
  const fx = x / xn;
  const fy = y / yn;
  const fz = z / zn;
  
  const fx3 = Math.pow(fx, 1/3);
  const fy3 = Math.pow(fy, 1/3);
  const fz3 = Math.pow(fz, 1/3);
  
  const L = fx > 0.008856 ? (116 * fy3 - 16) : (903.3 * fy);
  const A = 500 * ((fx > 0.008856 ? fx3 : (7.787 * fx + 16/116)) - 
                   (fy > 0.008856 ? fy3 : (7.787 * fy + 16/116)));
  const B = 200 * ((fy > 0.008856 ? fy3 : (7.787 * fy + 16/116)) - 
                   (fz > 0.008856 ? fz3 : (7.787 * fz + 16/116)));
  
  return { l: L, a: A, b: B };
}

// Delta E 2000 formula implementation
function deltaE2000(lab1, lab2) {
  const kL = 1, kC = 1, kH = 1;
  
  const L1 = lab1.l, a1 = lab1.a, b1 = lab1.b;
  const L2 = lab2.l, a2 = lab2.a, b2 = lab2.b;
  
  // Calculate C and h
  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cab = (C1 + C2) / 2;
  
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cab, 7) / (Math.pow(Cab, 7) + Math.pow(25, 7))));
  
  const ap1 = a1 * (1 + G);
  const ap2 = a2 * (1 + G);
  
  const Cp1 = Math.sqrt(ap1 * ap1 + b1 * b1);
  const Cp2 = Math.sqrt(ap2 * ap2 + b2 * b2);
  
  const hp1 = Math.atan2(b1, ap1) * 180 / Math.PI;
  const hp2 = Math.atan2(b2, ap2) * 180 / Math.PI;
  
  const h1 = hp1 >= 0 ? hp1 : hp1 + 360;
  const h2 = hp2 >= 0 ? hp2 : hp2 + 360;
  
  // Calculate deltas
  const dL = L2 - L1;
  const dCp = Cp2 - Cp1;
  
  let dhp;
  if (Cp1 * Cp2 === 0) {
    dhp = 0;
  } else if (Math.abs(h2 - h1) <= 180) {
    dhp = h2 - h1;
  } else if (h2 - h1 > 180) {
    dhp = h2 - h1 - 360;
  } else {
    dhp = h2 - h1 + 360;
  }
  
  const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin(dhp * Math.PI / 360);
  
  // Calculate averages
  const Lp = (L1 + L2) / 2;
  const Cp = (Cp1 + Cp2) / 2;
  
  let hp;
  if (Cp1 * Cp2 === 0) {
    hp = h1 + h2;
  } else if (Math.abs(h1 - h2) <= 180) {
    hp = (h1 + h2) / 2;
  } else if (h1 + h2 < 360) {
    hp = (h1 + h2 + 360) / 2;
  } else {
    hp = (h1 + h2 - 360) / 2;
  }
  
  // Calculate T
  const T = 1 - 0.17 * Math.cos((hp - 30) * Math.PI / 180) +
            0.24 * Math.cos(2 * hp * Math.PI / 180) +
            0.32 * Math.cos((3 * hp + 6) * Math.PI / 180) -
            0.20 * Math.cos((4 * hp - 63) * Math.PI / 180);
  
  // Calculate SL, SC, SH
  const SL = 1 + (0.015 * Math.pow(Lp - 50, 2)) / Math.sqrt(20 + Math.pow(Lp - 50, 2));
  const SC = 1 + 0.045 * Cp;
  const SH = 1 + 0.015 * Cp * T;
  
  // Calculate RT
  const dTheta = 30 * Math.exp(-Math.pow((hp - 275) / 25, 2));
  const RC = 2 * Math.sqrt(Math.pow(Cp, 7) / (Math.pow(Cp, 7) + Math.pow(25, 7)));
  const RT = -RC * Math.sin(2 * dTheta * Math.PI / 180);
  
  // Final calculation
  const dE = Math.sqrt(
    Math.pow(dL / (kL * SL), 2) +
    Math.pow(dCp / (kC * SC), 2) +
    Math.pow(dHp / (kH * SH), 2) +
    RT * (dCp / (kC * SC)) * (dHp / (kH * SH))
  );
  
  return dE;
}

// Convert Figma RGB to hex
function rgbToHex(color) {
  if (!color) return '#000000';
  const r = Math.round((color.r || 0) * 255);
  const g = Math.round((color.g || 0) * 255);
  const b = Math.round((color.b || 0) * 255);
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Main comparison endpoint (keep for backward compatibility)
app.post('/compare', upload.fields([
  { name: 'figmaDesign', maxCount: 1 },
  { name: 'renderedScreen', maxCount: 1 }
]), async (req, res) => {
  try {
    const figmaPath = req.files.figmaDesign[0].path;
    const renderedPath = req.files.renderedScreen[0].path;

    // Convert images to PNG if needed and resize to same dimensions
    const figmaPNG = await convertToPNG(figmaPath);
    const renderedPNG = await convertToPNG(renderedPath);

    // Get dimensions
    const figmaImg = PNG.sync.read(fs.readFileSync(figmaPNG));
    const renderedImg = PNG.sync.read(fs.readFileSync(renderedPNG));

    // Resize images to match dimensions
    const targetWidth = Math.max(figmaImg.width, renderedImg.width);
    const targetHeight = Math.max(figmaImg.height, renderedImg.height);

    const figmaResized = await resizeImage(figmaPNG, targetWidth, targetHeight);
    const renderedResized = await resizeImage(renderedPNG, targetWidth, targetHeight);

    // Load resized images
    const img1 = PNG.sync.read(fs.readFileSync(figmaResized));
    const img2 = PNG.sync.read(fs.readFileSync(renderedResized));

    // Create diff image
    const diff = new PNG({ width: targetWidth, height: targetHeight });

    // Perform pixel comparison with higher threshold for UI differences
    const numDiffPixels = pixelmatch(
      img1.data,
      img2.data,
      diff.data,
      targetWidth,
      targetHeight,
      { 
        threshold: 0.3, // Higher threshold to ignore minor differences
        includeAA: false, // Ignore anti-aliasing differences
        alpha: 0.2,
        diffColor: [255, 0, 0], // Red for different pixels
      }
    );
    
    // Extract color information from both images
    const figmaColors = await extractDominantColors(figmaResized);
    const renderedColors = await extractDominantColors(renderedResized);

    // Calculate metrics
    const totalPixels = targetWidth * targetHeight;
    const similarity = ((totalPixels - numDiffPixels) / totalPixels * 100).toFixed(2);

    // Save diff image
    const diffPath = path.join(uploadsDir, `diff-${Date.now()}.png`);
    fs.writeFileSync(diffPath, PNG.sync.write(diff));

    // Find regions of differences (connected components)
    const diffRegions = findDifferenceRegions(diff, targetWidth, targetHeight);
    
    // Create overlay with original image and bounding boxes
    const overlay = new PNG({ width: targetWidth, height: targetHeight });
    
    // First, copy the original image
    for (let i = 0; i < img1.data.length; i++) {
      overlay.data[i] = img1.data[i];
    }
    
    // Draw bounding boxes around difference regions
    diffRegions.forEach(region => {
      if (region.pixelCount > 100) { // Only show significant regions
        drawBoundingBox(overlay, region, targetWidth, targetHeight);
      }
    });
    
    const overlayPath = path.join(uploadsDir, `overlay-${Date.now()}.png`);
    fs.writeFileSync(overlayPath, PNG.sync.write(overlay));

    // Generate report
    const reportId = Date.now();
    const report = {
      id: reportId,
      timestamp: new Date().toISOString(),
      dimensions: { width: targetWidth, height: targetHeight },
      totalPixels: totalPixels,
      diffPixels: numDiffPixels,
      matchedPixels: totalPixels - numDiffPixels,
      similarity: similarity,
      figmaImage: `/uploads/${path.basename(figmaResized)}`,
      renderedImage: `/uploads/${path.basename(renderedResized)}`,
      diffImage: `/uploads/${path.basename(diffPath)}`,
      overlayImage: `/uploads/${path.basename(overlayPath)}`,
      diffRegions: diffRegions.filter(r => r.pixelCount > 100).length,
      significantDifferences: diffRegions.filter(r => r.pixelCount > 100),
      colorAnalysis: {
        figmaColors: figmaColors,
        renderedColors: renderedColors
      }
    };

    // Save report data
    fs.writeFileSync(
      path.join(reportsDir, `report-${reportId}.json`),
      JSON.stringify(report, null, 2)
    );

    res.json(report);

  } catch (error) {
    console.error('Comparison error:', error);
    res.status(500).json({ error: 'Comparison failed', message: error.message });
  }
});

// Helper function to convert image to PNG
async function convertToPNG(imagePath) {
  const outputPath = imagePath.replace(path.extname(imagePath), '.png');
  if (path.extname(imagePath).toLowerCase() !== '.png') {
    await sharp(imagePath).png().toFile(outputPath);
    return outputPath;
  }
  return imagePath;
}

// Helper function to resize image
async function resizeImage(imagePath, width, height) {
  const outputPath = imagePath.replace('.png', '-resized.png');
  await sharp(imagePath)
    .resize(width, height, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .toFile(outputPath);
  return outputPath;
}

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// Standalone OpenAI field detection endpoint
app.post('/detect-fields', upload.single('image'), async (req, res) => {
  try {
    const imagePath = req.file.path;
    const openaiApiKey = req.body.openaiApiKey;
    
    if (!openaiApiKey) {
      return res.status(400).json({ 
        error: 'OpenAI API key is required' 
      });
    }
    
    console.log('Starting standalone field detection...');
    
    const openai = new OpenAI({ apiKey: openaiApiKey });
    
    // Convert image to base64
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    
    // Get image metadata
    const metadata = await sharp(imagePath).metadata();
    console.log(`Image dimensions: ${metadata.width}x${metadata.height}`);
    
    const prompt = `Analyze this UI screenshot and detect ALL form fields and interactive elements.

TASK: Identify every form field, button, and interactive element in the image.

For each element found, provide:
1. Type (input, button, checkbox, radio, select, textarea, link, etc.)
2. Position (x, y coordinates from top-left corner)
3. Size (width and height in pixels)
4. Visual properties (background color, border color, border radius)
5. Any visible text (labels, placeholders, button text)
6. State (enabled/disabled, focused, etc.)

Be EXTREMELY precise with coordinates. Measure from the top-left corner of each element.

Return a JSON object with this structure:
{
  "imageInfo": {
    "width": ${metadata.width},
    "height": ${metadata.height}
  },
  "detectedElements": [
    {
      "type": "input|button|checkbox|radio|select|textarea|link|other",
      "bounds": {
        "x": 0,
        "y": 0,
        "width": 0,
        "height": 0
      },
      "properties": {
        "backgroundColor": "#hexcode or transparent",
        "borderColor": "#hexcode or none",
        "borderRadius": 0,
        "borderWidth": 0,
        "hasShadow": true|false
      },
      "text": {
        "label": "any label text near the field",
        "placeholder": "placeholder text if visible",
        "value": "current value if any",
        "buttonText": "text on buttons"
      },
      "state": {
        "isEnabled": true|false,
        "hasFocus": true|false,
        "isChecked": true|false
      },
      "confidence": 0.0-1.0,
      "notes": "any additional observations"
    }
  ],
  "summary": {
    "totalElements": 0,
    "elementsByType": {
      "input": 0,
      "button": 0,
      "checkbox": 0,
      "other": 0
    },
    "screenType": "login|register|form|dashboard|other",
    "observations": "general observations about the UI"
  }
}`;
    
    console.log('Sending image to OpenAI for field detection...');
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are an expert UI element detector. You analyze screenshots and identify ALL interactive elements with precise pixel-perfect accuracy. You MUST respond with ONLY a JSON object - no other text."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt
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
      max_tokens: 4000,
      temperature: 0.1
    });
    
    const aiResponse = response.choices[0].message.content;
    console.log('OpenAI response received');
    
    // Parse response
    let detectionResult;
    try {
      detectionResult = JSON.parse(aiResponse);
    } catch (e) {
      // Try to extract JSON from response
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        detectionResult = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Invalid JSON response from OpenAI');
      }
    }
    
    // Log summary
    if (detectionResult.detectedElements) {
      console.log(`Detected ${detectionResult.detectedElements.length} elements`);
      detectionResult.detectedElements.forEach((elem, index) => {
        console.log(`  ${index + 1}. ${elem.type} at (${elem.bounds?.x}, ${elem.bounds?.y})`);
      });
    }
    
    res.json({
      success: true,
      imagePath: `/uploads/${path.basename(imagePath)}`,
      detection: detectionResult,
      rawResponse: aiResponse
    });
    
  } catch (error) {
    console.error('Field detection error:', error);
    res.status(500).json({ 
      error: 'Field detection failed', 
      message: error.message 
    });
  }
});
app.use('/reports', express.static(reportsDir));

// Get report endpoint
app.get('/report/:id', (req, res) => {
  const reportPath = path.join(reportsDir, `report-${req.params.id}.json`);
  if (fs.existsSync(reportPath)) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    res.json(report);
  } else {
    res.status(404).json({ error: 'Report not found' });
  }
});

// Helper function to find connected regions of differences
function findDifferenceRegions(diffImage, width, height) {
  const visited = new Array(width * height).fill(false);
  const regions = [];
  
  // Convert image data to binary mask
  const diffMask = [];
  for (let i = 0; i < diffImage.data.length; i += 4) {
    diffMask.push(diffImage.data[i] > 0 || diffImage.data[i + 1] > 0 || diffImage.data[i + 2] > 0);
  }
  
  // Find connected components using flood fill
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      
      if (!visited[idx] && diffMask[idx]) {
        const region = floodFill(diffMask, visited, x, y, width, height);
        if (region.pixelCount > 10) { // Ignore tiny regions
          regions.push(region);
        }
      }
    }
  }
  
  return regions;
}

// Flood fill to find connected component
function floodFill(mask, visited, startX, startY, width, height) {
  const region = {
    minX: width,
    minY: height,
    maxX: 0,
    maxY: 0,
    pixelCount: 0
  };
  
  const stack = [{x: startX, y: startY}];
  
  while (stack.length > 0) {
    const {x, y} = stack.pop();
    const idx = y * width + x;
    
    if (x < 0 || x >= width || y < 0 || y >= height || visited[idx] || !mask[idx]) {
      continue;
    }
    
    visited[idx] = true;
    region.pixelCount++;
    region.minX = Math.min(region.minX, x);
    region.maxX = Math.max(region.maxX, x);
    region.minY = Math.min(region.minY, y);
    region.maxY = Math.max(region.maxY, y);
    
    // Check 8 neighbors
    stack.push({x: x + 1, y: y});
    stack.push({x: x - 1, y: y});
    stack.push({x: x, y: y + 1});
    stack.push({x: x, y: y - 1});
    stack.push({x: x + 1, y: y + 1});
    stack.push({x: x - 1, y: y - 1});
    stack.push({x: x + 1, y: y - 1});
    stack.push({x: x - 1, y: y + 1});
  }
  
  return region;
}

// Draw bounding box on image
function drawBoundingBox(image, region, width, height) {
  const color = {r: 255, g: 0, b: 0}; // Red color
  const thickness = 3;
  
  // Expand box slightly for visibility
  const padding = 5;
  const minX = Math.max(0, region.minX - padding);
  const maxX = Math.min(width - 1, region.maxX + padding);
  const minY = Math.max(0, region.minY - padding);
  const maxY = Math.min(height - 1, region.maxY + padding);
  
  // Draw top and bottom lines
  for (let x = minX; x <= maxX; x++) {
    for (let t = 0; t < thickness; t++) {
      // Top line
      if (minY + t < height) {
        const idx = ((minY + t) * width + x) * 4;
        image.data[idx] = color.r;
        image.data[idx + 1] = color.g;
        image.data[idx + 2] = color.b;
      }
      // Bottom line
      if (maxY - t >= 0) {
        const idx = ((maxY - t) * width + x) * 4;
        image.data[idx] = color.r;
        image.data[idx + 1] = color.g;
        image.data[idx + 2] = color.b;
      }
    }
  }
  
  // Draw left and right lines
  for (let y = minY; y <= maxY; y++) {
    for (let t = 0; t < thickness; t++) {
      // Left line
      if (minX + t < width) {
        const idx = (y * width + minX + t) * 4;
        image.data[idx] = color.r;
        image.data[idx + 1] = color.g;
        image.data[idx + 2] = color.b;
      }
      // Right line
      if (maxX - t >= 0) {
        const idx = (y * width + maxX - t) * 4;
        image.data[idx] = color.r;
        image.data[idx + 1] = color.g;
        image.data[idx + 2] = color.b;
      }
    }
  }
}

// Extract dominant colors from an image with improved accuracy
async function extractDominantColors(imagePath) {
  try {
    const metadata = await sharp(imagePath).metadata();
    console.log('Analyzing image:', metadata.width, 'x', metadata.height);
    
    // Multiple sampling strategies for better color detection
    const strategies = [
      // 1. Full image sampling with better resize
      await sampleFullImage(imagePath, metadata),
      // 2. Grid-based sampling
      await sampleImageGrid(imagePath, metadata),
      // 3. Edge detection sampling
      await sampleEdgeColors(imagePath, metadata)
    ];
    
    // Merge all detected colors
    const allColors = new Map();
    strategies.forEach(colors => {
      colors.forEach((count, hex) => {
        allColors.set(hex, (allColors.get(hex) || 0) + count);
      });
    });
    
    // Convert to array and filter
    let colorArray = Array.from(allColors.entries())
      .map(([hex, count]) => ({
        hex,
        rgb: hexToRgb(hex),
        count,
        lab: hexToLab(hex)
      }))
      .filter(color => {
        // Filter out near-white and near-black colors
        const rgb = color.rgb;
        const brightness = (rgb.r + rgb.g + rgb.b) / 3;
        const isNearWhite = brightness > 240;
        const isNearBlack = brightness < 15;
        const isGray = Math.abs(rgb.r - rgb.g) < 10 && Math.abs(rgb.g - rgb.b) < 10 && Math.abs(rgb.r - rgb.b) < 10;
        
        // Keep colors that are not too light, not too dark, and not gray (unless they're UI grays)
        return !isNearWhite && !isNearBlack && (!isGray || (brightness > 100 && brightness < 200));
      });
    
    // Cluster similar colors using k-means
    const clusteredColors = clusterColors(colorArray, 15); // Max 15 clusters
    
    // Sort by importance (frequency * saturation)
    const rankedColors = clusteredColors
      .map(cluster => {
        const rgb = cluster.rgb;
        const saturation = getColorSaturation(rgb);
        const importance = cluster.count * (0.5 + saturation * 0.5);
        
        return {
          hex: cluster.hex,
          rgb: cluster.rgb,
          frequency: cluster.count,
          importance,
          saturation
        };
      })
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 10); // Top 10 colors
    
    // Find the most important color as dominant
    const dominant = rankedColors[0]?.hex || '#000000';
    
    console.log(`Detected ${rankedColors.length} important colors from ${colorArray.length} raw colors`);
    
    return {
      dominant,
      palette: rankedColors
    };
  } catch (error) {
    console.error('Color extraction error:', error);
    return {
      dominant: '#000000',
      palette: []
    };
  }
}

// Sample full image with contain mode
async function sampleFullImage(imagePath, metadata) {
  const sampleSize = 150; // Larger sample for better accuracy
  const buffer = await sharp(imagePath)
    .resize(sampleSize, sampleSize, { 
      fit: 'contain', // Preserve entire image
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    })
    .raw()
    .toBuffer();
  
  const colorMap = new Map();
  const channels = metadata.channels || 3;
  
  for (let i = 0; i < buffer.length; i += channels) {
    const r = buffer[i];
    const g = buffer[i + 1];
    const b = buffer[i + 2];
    
    // Skip pure white (background)
    if (r === 255 && g === 255 && b === 255) continue;
    
    const hex = rgbToHex2(r, g, b);
    colorMap.set(hex, (colorMap.get(hex) || 0) + 1);
  }
  
  return colorMap;
}

// Sample image in a grid pattern
async function sampleImageGrid(imagePath, metadata) {
  const gridSize = 20; // 20x20 grid
  const cellWidth = Math.floor(metadata.width / gridSize);
  const cellHeight = Math.floor(metadata.height / gridSize);
  const colorMap = new Map();
  
  // Get raw image buffer
  const { data, info } = await sharp(imagePath)
    .raw()
    .toBuffer({ resolveWithObject: true });
  
  const channels = info.channels;
  
  // Sample center of each grid cell
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const x = Math.floor(col * cellWidth + cellWidth / 2);
      const y = Math.floor(row * cellHeight + cellHeight / 2);
      
      if (x < info.width && y < info.height) {
        const idx = (y * info.width + x) * channels;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        
        const hex = rgbToHex2(r, g, b);
        colorMap.set(hex, (colorMap.get(hex) || 0) + 1);
      }
    }
  }
  
  return colorMap;
}

// Sample colors from edges (where UI elements typically are)
async function sampleEdgeColors(imagePath, metadata) {
  // Use edge detection to find UI boundaries
  const edges = await sharp(imagePath)
    .greyscale()
    .convolve({
      width: 3,
      height: 3,
      kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] // Edge detection kernel
    })
    .raw()
    .toBuffer();
  
  // Get original image
  const { data: original } = await sharp(imagePath)
    .raw()
    .toBuffer({ resolveWithObject: true });
  
  const colorMap = new Map();
  const channels = metadata.channels || 3;
  const threshold = 50; // Edge strength threshold
  
  // Sample colors where edges are detected
  for (let i = 0; i < edges.length; i++) {
    if (edges[i] > threshold) {
      const pixelIdx = i * channels;
      const r = original[pixelIdx];
      const g = original[pixelIdx + 1];
      const b = original[pixelIdx + 2];
      
      const hex = rgbToHex2(r, g, b);
      colorMap.set(hex, (colorMap.get(hex) || 0) + 1);
    }
  }
  
  return colorMap;
}

// K-means clustering for colors
function clusterColors(colors, maxClusters) {
  if (colors.length <= maxClusters) {
    return colors;
  }
  
  // Initialize clusters with k-means++
  const clusters = [];
  const usedIndices = new Set();
  
  // First cluster center is random
  const firstIdx = Math.floor(Math.random() * colors.length);
  clusters.push({
    center: colors[firstIdx].lab,
    members: [],
    hex: colors[firstIdx].hex,
    rgb: colors[firstIdx].rgb,
    count: 0
  });
  usedIndices.add(firstIdx);
  
  // Select remaining centers using k-means++ method
  for (let i = 1; i < Math.min(maxClusters, colors.length); i++) {
    let maxMinDist = -1;
    let bestIdx = -1;
    
    colors.forEach((color, idx) => {
      if (usedIndices.has(idx)) return;
      
      // Find minimum distance to existing centers
      let minDist = Infinity;
      clusters.forEach(cluster => {
        const dist = deltaE2000(color.lab, cluster.center);
        minDist = Math.min(minDist, dist);
      });
      
      if (minDist > maxMinDist) {
        maxMinDist = minDist;
        bestIdx = idx;
      }
    });
    
    if (bestIdx !== -1) {
      clusters.push({
        center: colors[bestIdx].lab,
        members: [],
        hex: colors[bestIdx].hex,
        rgb: colors[bestIdx].rgb,
        count: 0
      });
      usedIndices.add(bestIdx);
    }
  }
  
  // Assign colors to clusters
  let changed = true;
  let iterations = 0;
  
  while (changed && iterations < 20) {
    changed = false;
    
    // Clear members
    clusters.forEach(cluster => {
      cluster.members = [];
      cluster.count = 0;
    });
    
    // Assign each color to nearest cluster
    colors.forEach(color => {
      let minDist = Infinity;
      let bestCluster = null;
      
      clusters.forEach(cluster => {
        const dist = deltaE2000(color.lab, cluster.center);
        if (dist < minDist) {
          minDist = dist;
          bestCluster = cluster;
        }
      });
      
      if (bestCluster) {
        bestCluster.members.push(color);
        bestCluster.count += color.count;
      }
    });
    
    // Update cluster centers
    clusters.forEach(cluster => {
      if (cluster.members.length > 0) {
        // Calculate new center as weighted average
        let totalWeight = 0;
        let lSum = 0, aSum = 0, bSum = 0;
        
        cluster.members.forEach(member => {
          const weight = member.count;
          totalWeight += weight;
          lSum += member.lab.l * weight;
          aSum += member.lab.a * weight;
          bSum += member.lab.b * weight;
        });
        
        const newCenter = {
          l: lSum / totalWeight,
          a: aSum / totalWeight,
          b: bSum / totalWeight
        };
        
        // Check if center changed significantly
        if (deltaE2000(cluster.center, newCenter) > 0.1) {
          changed = true;
          cluster.center = newCenter;
          
          // Find the member closest to the new center
          let minDist = Infinity;
          let bestMember = cluster.members[0];
          
          cluster.members.forEach(member => {
            const dist = deltaE2000(member.lab, newCenter);
            if (dist < minDist) {
              minDist = dist;
              bestMember = member;
            }
          });
          
          cluster.hex = bestMember.hex;
          cluster.rgb = bestMember.rgb;
        }
      }
    });
    
    iterations++;
  }
  
  // Filter out empty clusters and those with very few members
  return clusters
    .filter(cluster => cluster.count > 10)
    .map(cluster => ({
      hex: cluster.hex,
      rgb: cluster.rgb,
      count: cluster.count
    }));
}

// Calculate color saturation
function getColorSaturation(rgb) {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  
  if (max === 0) return 0;
  
  return (max - min) / max;
}

// Temporary - remove this duplicate later
function rgbToHex2(r, g, b) {
  return '#' + [r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

// Convert hex to RGB
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});