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
    
    // Extract properties from Figma JSON
    const figmaProperties = extractFigmaProperties(figmaJSON);
    
    // Perform standard computer vision analysis
    const detectedProperties = await analyzeScreenshot(screenshotPath);
    
    // Perform AI-powered analysis
    const aiAnalysis = await analyzeWithOpenAI(screenshotPath, figmaProperties, openaiApiKey);
    
    // Combine both analyses
    const enhancedDetectedProperties = combineAnalyses(detectedProperties, aiAnalysis);
    
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
      figmaProperties: figmaProperties,
      detectedProperties: enhancedDetectedProperties,
      aiAnalysis: aiAnalysis,
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
        screenshotPath: `/uploads/${path.basename(screenshotPath)}`
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

// Create detailed prompt for UI analysis
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
  
  // Calculate enhanced accuracy including AI insights
  const aiInsightScore = detected.enhancedAnalysis?.confidenceScore || 0.5;
  const enhancedAccuracy = (basicComparison.accuracy * 0.7 + aiInsightScore * 100 * 0.3).toFixed(2);
  
  return {
    ...basicComparison,
    accuracy: enhancedAccuracy,
    layoutMismatches,
    spacingMismatches: [...(basicComparison.spacingMismatches || []), ...spacingMismatches],
    enhancedWithAI: true,
    aiConfidence: aiInsightScore
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
    hierarchy: []
  };
  
  const colorSet = new Set();
  let elementIndex = 0;
  
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
      element.properties.position = {
        x: Math.round(node.absoluteBoundingBox.x),
        y: Math.round(node.absoluteBoundingBox.y),
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
  
  // Calculate spacing relationships between sibling elements
  properties.spacingRelationships = calculateSpacingRelationships(properties.elements);
  
  return properties;
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
    layoutMismatches: layoutMismatches
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