// Shared Figma utilities for both client and server
// This file contains the exact same logic used on the server for processing Figma JSON

function rgbToHex(color) {
  if (!color) return '#000000';
  const r = Math.round((color.r || 0) * 255);
  const g = Math.round((color.g || 0) * 255);
  const b = Math.round((color.b || 0) * 255);
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function calculateSpacingRelationships(elements) {
  const relationships = [];
  
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const elem1 = elements[i];
      const elem2 = elements[j];
      
      if (!elem1.properties?.position || !elem2.properties?.position) continue;
      
      const pos1 = elem1.properties.position;
      const pos2 = elem2.properties.position;
      
      // Calculate horizontal and vertical spacing
      const horizontalSpacing = Math.abs(pos2.x - (pos1.x + pos1.width));
      const verticalSpacing = Math.abs(pos2.y - (pos1.y + pos1.height));
      
      // Only record meaningful relationships (within reasonable distance)
      if (horizontalSpacing < 100 || verticalSpacing < 100) {
        relationships.push({
          from: elem1.id,
          to: elem2.id,
          horizontal: horizontalSpacing,
          vertical: verticalSpacing,
          type: horizontalSpacing < verticalSpacing ? 'horizontal' : 'vertical'
        });
      }
    }
  }
  
  return relationships;
}

function detectScreenType(properties) {
  const keywords = {
    login: /login|signin|authenticate|password|username|email/i,
    register: /register|signup|create.*account|join/i,
    dashboard: /dashboard|overview|analytics|metrics|stats/i,
    profile: /profile|account|settings|preferences/i,
    form: /form|input|field|submit/i
  };
  
  // Check text content and element names
  const allText = [
    ...properties.typography.map(t => t.content),
    ...properties.elements.map(e => e.name),
    ...properties.formFields.map(f => f.name)
  ].join(' ');
  
  for (const [type, pattern] of Object.entries(keywords)) {
    if (pattern.test(allText)) {
      return type;
    }
  }
  
  // Default based on form field count
  if (properties.formFields.length > 3) return 'form';
  if (properties.formFields.length > 0) return 'login';
  
  return 'unknown';
}

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
  const allNodes = [];
  let frameOrigin = null;
  
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
      
      const distance = Math.sqrt(Math.pow(nodeX - textX, 2) + Math.pow(nodeY - textY, 2));
      
      const isAbove = textY < nodeY;
      const isLeft = textX < nodeX && Math.abs(textY - nodeY) < 20;
      
      if (distance < minDistance && (isAbove || isLeft)) {
        minDistance = distance;
        closestText = textNode.characters;
      }
    });
    
    return closestText;
  }
  
  function extractPlaceholder(node, childNodes) {
    if (!node.absoluteBoundingBox) return null;
    
    const nodeBounds = node.absoluteBoundingBox;
    
    for (const child of childNodes) {
      if (child.type === 'TEXT' && child.absoluteBoundingBox && child.characters) {
        const childBounds = child.absoluteBoundingBox;
        
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
  
  function traverseNode(node, parentId = null, depth = 0) {
    const currentElementId = `element_${elementIndex++}`;
    
    const element = {
      id: currentElementId,
      type: node.type,
      name: node.name || `Unnamed ${node.type}`,
      parentId: parentId,
      depth: depth,
      properties: {}
    };
    
    if (node.absoluteBoundingBox) {
      if (depth === 0 && !frameOrigin) {
        frameOrigin = {
          x: node.absoluteBoundingBox.x,
          y: node.absoluteBoundingBox.y
        };
      }
      
      const relativeX = frameOrigin ? node.absoluteBoundingBox.x - frameOrigin.x : node.absoluteBoundingBox.x;
      const relativeY = frameOrigin ? node.absoluteBoundingBox.y - frameOrigin.y : node.absoluteBoundingBox.y;
      
      element.properties.position = {
        x: Math.round(relativeX),
        y: Math.round(relativeY),
        width: Math.round(node.absoluteBoundingBox.width),
        height: Math.round(node.absoluteBoundingBox.height)
      };
      
      if (!properties.dimensions.width && depth === 0) {
        properties.dimensions = {
          width: element.properties.position.width,
          height: element.properties.position.height
        };
      }
    }
    
    if (node.constraints) {
      element.properties.constraints = {
        horizontal: node.constraints.horizontal,
        vertical: node.constraints.vertical
      };
    }
    
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
          
          element.properties.border = {
            width: strokeWeight,
            color: hex,
            style: 'solid'
          };
        }
      });
    }
    
    if (node.cornerRadius !== undefined) {
      element.properties.borderRadius = node.cornerRadius;
      if (!properties.borders.borderRadius) {
        properties.borders.borderRadius = node.cornerRadius;
      }
    }
    
    if (node.rectangleCornerRadii) {
      element.properties.borderRadius = {
        topLeft: node.rectangleCornerRadii[0] || 0,
        topRight: node.rectangleCornerRadii[1] || 0,
        bottomRight: node.rectangleCornerRadii[2] || 0,
        bottomLeft: node.rectangleCornerRadii[3] || 0
      };
    }
    
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
        
        if (!properties.shadows.dropShadow) {
          properties.shadows = element.properties.shadows[0];
        }
      }
    }
    
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
    
    if (node.paddingLeft !== undefined || node.paddingTop !== undefined || 
        node.paddingRight !== undefined || node.paddingBottom !== undefined) {
      
      element.properties.padding = {
        top: node.paddingTop || 0,
        right: node.paddingRight || 0,
        bottom: node.paddingBottom || 0,
        left: node.paddingLeft || 0
      };
      
      if (!properties.spacing.padding) {
        properties.spacing.padding = element.properties.padding;
      }
    }
    
    if (node.layoutMode) {
      element.properties.layout = {
        mode: node.layoutMode,
        primaryAxisSizingMode: node.primaryAxisSizingMode,
        counterAxisSizingMode: node.counterAxisSizingMode,
        primaryAxisAlignItems: node.primaryAxisAlignItems,
        counterAxisAlignItems: node.counterAxisAlignItems,
        itemSpacing: node.itemSpacing || 0
      };
      
      if (!properties.layout.mode) {
        properties.layout = element.properties.layout;
      }
    }
    
    if (node.itemSpacing !== undefined) {
      element.properties.gap = node.itemSpacing;
      if (!properties.spacing.gap) {
        properties.spacing.gap = node.itemSpacing;
      }
    }
    
    allNodes.push({ ...node, elementId: currentElementId, element });
    
    const fieldPatterns = /input|field|email|password|username|search|button|submit|login|register|signup|signin/i;
    const isFormField = (node.type === 'RECTANGLE' || node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') 
                        && fieldPatterns.test(node.name);
    
    const isInstanceWithText = node.type === 'INSTANCE' && 
                               node.children && 
                               node.children.some(child => 
                                 child.type === 'TEXT' && 
                                 child.characters && 
                                 /@|example\.com|username/i.test(child.characters)
                               );
    
    if ((isFormField || isInstanceWithText) && node.absoluteBoundingBox) {
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
            shadow: element.properties.shadows
          }
        },
        label: null,
        placeholder: null
      };
      
      properties.formFields.push(field);
    }
    
    properties.elements.push(element);
    properties.hierarchy.push({
      id: currentElementId,
      parentId: parentId,
      depth: depth,
      type: node.type,
      name: node.name
    });
    
    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(child => {
        traverseNode(child, currentElementId, depth + 1);
      });
    }
  }
  
  // Handle different JSON formats - same logic as server.js
  if (json.nodes) {
    // Direct pasted JSON format - traverse all nodes
    for (const nodeId in json.nodes) {
      const node = json.nodes[nodeId];
      if (node.document) {
        traverseNode(node.document);
      }
    }
  } else if (json.document) {
    // Figma API response format
    if (json.document.children) {
      json.document.children.forEach(child => traverseNode(child));
    } else {
      traverseNode(json.document);
    }
  } else if (json.children) {
    // Direct frame/node format
    json.children.forEach(child => traverseNode(child));
  } else {
    // Fallback - try to traverse the object directly
    traverseNode(json);
  }
  
  const allTextNodes = allNodes.filter(n => n.type === 'TEXT');
  const allChildNodes = allNodes.map(n => n);
  
  properties.formFields.forEach(field => {
    const fieldNode = allNodes.find(n => n.elementId === field.id);
    if (fieldNode) {
      field.label = findNearbyText(fieldNode, allTextNodes);
      field.placeholder = extractPlaceholder(fieldNode, allChildNodes);
    }
  });
  
  properties.spacingRelationships = calculateSpacingRelationships(properties.elements);
  properties.screenType = detectScreenType(properties);
  
  return properties;
}

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractFigmaProperties, rgbToHex };
}