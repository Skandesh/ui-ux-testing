// Helper function to escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Helper function to safely set text content
function setTextContent(elementId, value) {
  const element = document.getElementById(elementId);
  if (element) {
    element.textContent = value;
  }
}

// Helper function to safely set innerHTML
function setInnerHTML(elementId, html) {
  const element = document.getElementById(elementId);
  if (element) {
    element.innerHTML = html;
  }
}

// Global function for tab switching (called from HTML onclick)
function showResultTab(tabName) {
  // Get all tab buttons and content
  const tabButtons = document.querySelectorAll('.tab-button');
  const tabContents = document.querySelectorAll('.result-tab-content');

  // Remove active class from all
  tabButtons.forEach((btn) => btn.classList.remove('active'));
  tabContents.forEach((content) => content.classList.remove('active'));

  // Add active class to selected tab
  const selectedTab = document.getElementById(`${tabName}-tab`);
  if (selectedTab) {
    selectedTab.classList.add('active');
  }

  // Add active class to corresponding button based on onclick attribute
  tabButtons.forEach((btn, index) => {
    if (
      btn.getAttribute('onclick') &&
      btn.getAttribute('onclick').includes(`'${tabName}'`)
    ) {
      btn.classList.add('active');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('compareForm');
  const screenshotInput = document.getElementById('codeScreenshot');
  const jsonPreview = document.getElementById('jsonPreview');

  // Store fetched Figma data
  let fetchedFigmaJSON = null;
  const screenshotPreview = document.getElementById('screenshotPreview');
  const loading = document.getElementById('loading');
  const results = document.getElementById('results');
  const downloadBtn = document.getElementById('downloadReport');

  // Figma input elements
  const figmaLinkInput = document.getElementById('figmaLink');
  const figmaTokenInput = document.getElementById('figmaToken');
  const fetchFigmaBtn = document.getElementById('fetchFigmaBtn');
  const rawAnalyzeBtn = document.getElementById('rawAnalyzeBtn');

  // Field detection elements
  const detectionImage = document.getElementById('detectionImage');
  const detectionApiKey = document.getElementById('detectionApiKey');
  const detectFieldsBtn = document.getElementById('detectFieldsBtn');
  const detectionLoading = document.getElementById('detectionLoading');
  const detectionResults = document.getElementById('detectionResults');
  const detectionImagePreview = document.getElementById(
    'detectionImagePreview'
  );

  // Check if detection elements exist
  if (!detectFieldsBtn) {
    console.error('Detect Fields button not found!');
  }

  let currentReport = null;
  let parsedJSON = null;

  // Preview uploaded screenshot
  if (screenshotInput) {
    screenshotInput.addEventListener('change', (e) => {
      previewImage(e.target.files[0], screenshotPreview);
    });
  }

  // Fetch Figma design
  if (fetchFigmaBtn) {
    fetchFigmaBtn.addEventListener('click', async () => {
      const figmaLink = figmaLinkInput.value.trim();
      const figmaToken = figmaTokenInput.value.trim();
      const statusDiv = document.getElementById('figmaStatus');

      // Hide previous status
      statusDiv.className = 'status-message';

      if (!figmaLink || !figmaToken) {
        showStatus('Please enter both Figma link and access token', 'error');
        return;
      }

      // Parse Figma URL
      const figmaData = parseFigmaUrl(figmaLink);
      if (!figmaData) {
        showStatus(
          'Invalid Figma URL. Please use a valid Figma file or design link.',
          'error'
        );
        return;
      }

      fetchFigmaBtn.disabled = true;
      fetchFigmaBtn.textContent = 'Fetching...';
      showStatus('Connecting to Figma API...', 'info');

      try {
        // Get proxy checkbox value
        const useProxy = document.getElementById('useProxy').checked;
        
        const response = await fetchFigmaDesign(
          figmaData.fileKey,
          figmaData.nodeId,
          figmaToken,
          false, // useHeaderAuth is deprecated, always use headers
          useProxy
        );
        if (response) {
          // Handle new response structure
          if (response.design) {
            fetchedFigmaJSON = {
              ...response.design,
              properties: response.properties,
              formFields: response.formFields
            };
          } else {
            // Fallback for old format
            fetchedFigmaJSON = response;
          }
          parsedJSON = fetchedFigmaJSON;

          try {
            displayJSONPreview(fetchedFigmaJSON);
          } catch (previewError) {
            console.error('Error displaying JSON preview:', previewError);
            // Still show success since we got the data
            jsonPreview.innerHTML =
              '<p style="color: green;">Design fetched successfully! (Preview error)</p>';
          }

          const nodeInfo = figmaData.nodeId
            ? ` (Node: ${figmaData.nodeId})`
            : '';
          showStatus(`Successfully fetched design${nodeInfo}`, 'success');
        }
      } catch (error) {
        showStatus('Error: ' + error.message, 'error');
        console.error('Figma fetch error:', error);
      } finally {
        fetchFigmaBtn.disabled = false;
        fetchFigmaBtn.textContent = 'Fetch Design';
      }
    });

    // Show status message
    function showStatus(message, type) {
      const statusDiv = document.getElementById('figmaStatus');
      statusDiv.textContent = message;
      statusDiv.className = `status-message ${type} show`;

      // Auto-hide success messages after 5 seconds
      if (type === 'success') {
        setTimeout(() => {
          statusDiv.className = 'status-message';
        }, 5000);
      }
    }

    function previewImage(file, container) {
      if (file && file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          container.innerHTML = `<img src="${e.target.result}" alt="Preview">`;
        };
        reader.readAsDataURL(file);
      }
    }

    // Handle form submission
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!fetchedFigmaJSON) {
          alert(
            'Please fetch a Figma design first using the Fetch Design button'
          );
          return;
        }

        if (!screenshotInput.files[0]) {
          alert('Please select a code output screenshot');
          return;
        }

        const openaiApiKey = document
          .getElementById('openaiApiKey')
          .value.trim();
        const useAI = openaiApiKey.length > 0;

        const formData = new FormData();
        formData.append('figmaJSON', JSON.stringify(fetchedFigmaJSON));
        formData.append('screenshot', screenshotInput.files[0]);

        if (useAI) {
          formData.append('openaiApiKey', openaiApiKey);
        }

        // Show loading with appropriate message
        if (loading) {
          loading.classList.remove('hidden');
          results.classList.add('hidden');
          const loadingMessage = loading.querySelector('p');
          if (loadingMessage) {
            loadingMessage.textContent = useAI
              ? 'Analyzing with AI enhancement...'
              : 'Analyzing pixel differences...';
          }
        } else {
          console.error('Loading element not found');
        }

        try {
          const endpoint = useAI ? '/analyze-with-ai' : '/analyze';
          const response = await fetch(endpoint, {
            method: 'POST',
            body: formData,
          });

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Analysis failed');
          }

          const report = await response.json();
          currentReport = report;
          displayResults(report);

          // Show tabs after results are loaded
          const resultTabs = document.getElementById('resultTabs');
          if (resultTabs) resultTabs.classList.remove('hidden');

          // If AI analysis was successful, show AI tab by default
          if (useAI && report.analysisType === 'AI_ENHANCED') {
            showResultTab('ai-analysis');
          }
        } catch (error) {
          alert('Error: ' + error.message);
          // Reset loading message if it exists
          const loadingMsg = loading ? loading.querySelector('p') : null;
          if (loadingMsg) {
            loadingMsg.textContent = 'Analyzing pixel differences...';
          }
        } finally {
          if (loading) loading.classList.add('hidden');
        }
      });
    }

    // Raw Analysis button handler
    if (rawAnalyzeBtn) {
      rawAnalyzeBtn.addEventListener('click', async () => {
        if (!fetchedFigmaJSON) {
          alert(
            'Please fetch a Figma design first using the Fetch Design button'
          );
          return;
        }

        if (!screenshotInput.files[0]) {
          alert('Please select a screenshot');
          return;
        }

        const formData = new FormData();
        formData.append('figmaJSON', JSON.stringify(fetchedFigmaJSON));
        formData.append('screenshot', screenshotInput.files[0]);

        // Show loading
        loading.classList.remove('hidden');
        results.classList.add('hidden');
        const loadingMessage = loading.querySelector('p');
        if (loadingMessage) {
          loadingMessage.textContent = 'Performing raw analysis without AI...';
        }

        try {
          const response = await fetch('/analyze', {
            method: 'POST',
            body: formData,
          });

          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || 'Analysis failed');
          }

          const report = await response.json();
          currentReport = report;

          displayResults(report);
          results.classList.remove('hidden');
          const resultTabsRaw = document.getElementById('resultTabs');
          if (resultTabsRaw) resultTabsRaw.classList.remove('hidden');

          // Show overview tab for raw analysis
          showResultTab('overview');
        } catch (error) {
          alert('Error: ' + error.message);
        } finally {
          if (loading) loading.classList.add('hidden');
        }
      });
    }

    function displayResults(report) {
      const accuracy = parseFloat(report.accuracy || 0);

      // Display dimension validation warning if needed
      if (report.dimensionValidation && !report.dimensionValidation.isValid) {
        const warningDiv = document.getElementById('dimensionWarning');
        const warningMessage = document.getElementById(
          'dimensionWarningMessage'
        );
        warningMessage.textContent = report.dimensionValidation.message;
        warningDiv.classList.remove('hidden');
      } else {
        const dimWarning = document.getElementById('dimensionWarning');
        if (dimWarning) dimWarning.classList.add('hidden');
      }

      // Update score circle
      const scoreCircle = document.getElementById('scoreCircle');
      const scoreDescription = document.getElementById('scoreDescription');

      const similarityElem = document.getElementById('similarity');
      if (similarityElem) similarityElem.textContent = accuracy + '%';

      // Style score circle based on accuracy
      scoreCircle.classList.remove(
        'score-excellent',
        'score-good',
        'score-poor'
      );

      if (accuracy >= 95) {
        scoreCircle.classList.add('score-excellent');
        scoreDescription.textContent =
          'Excellent! Implementation matches specifications.';
      } else if (accuracy >= 80) {
        scoreCircle.classList.add('score-good');
        scoreDescription.textContent =
          'Good implementation with minor differences.';
      } else {
        scoreCircle.classList.add('score-poor');
        scoreDescription.textContent =
          'Multiple specification mismatches found.';
      }

      // Update stats
      const diffRegionsElem = document.getElementById('diffRegions');
      if (diffRegionsElem)
        diffRegionsElem.textContent = report.totalMismatches || '0';
      // Fix: Display count instead of array
      const colorMismatchCount = Array.isArray(report.colorMismatches)
        ? report.colorMismatches.length
        : report.colorMismatches || '0';
      const diffPixelsElem = document.getElementById('diffPixels');
      if (diffPixelsElem) diffPixelsElem.textContent = colorMismatchCount;

      // Display specifications vs detected properties
      displaySpecComparison(report);

      // Display spacing visualization if available
      if (report.visualizations && report.visualizations.spacingOverlay) {
        const spacingImg = document.getElementById('spacingOverlay');
        const placeholder = document.getElementById(
          'spacingOverlayPlaceholder'
        );

        spacingImg.src = report.visualizations.spacingOverlay;
        spacingImg.style.display = 'block';
        placeholder.style.display = 'none';
      }

      // Show results
      results.classList.remove('hidden');

      // Display detailed analysis
      displayDetailedAnalysis(report);

      // Display AI analysis if available
      if (report.analysisType === 'AI_ENHANCED') {
        displayAIAnalysis(report);
      }

      // Display field analysis
      displayFieldAnalysis(report);
    }

    // Generate insights based on analysis results
    function generateInsights(report) {
      const insights = [];
      
      // Field analysis insights
      if (report.fieldAnalysis && report.fieldAnalysis.fieldMapping) {
        const mapping = report.fieldAnalysis.fieldMapping;
        const matchRate = mapping.summary?.matchRate || 0;
        
        if (matchRate >= 0.9) {
          insights.push('Excellent field implementation - all form elements match the design specifications');
        } else if (matchRate >= 0.7) {
          insights.push(`Good field implementation with ${Math.round(matchRate * 100)}% match rate`);
        } else {
          insights.push(`Field implementation needs improvement - only ${Math.round(matchRate * 100)}% match rate`);
        }
        
        if (mapping.unmatchedFigma && mapping.unmatchedFigma.length > 0) {
          insights.push(`Missing ${mapping.unmatchedFigma.length} expected field(s) from the Figma design`);
        }
        
        if (mapping.unmatchedDetected && mapping.unmatchedDetected.length > 0) {
          insights.push(`Found ${mapping.unmatchedDetected.length} unexpected field(s) not in the design`);
        }
      }
      
      // Color analysis insights
      if (report.colorMismatches && report.colorMismatches.length > 0) {
        insights.push(`Detected ${report.colorMismatches.length} color mismatches - review brand consistency`);
      }
      
      // Layout insights
      if (report.accuracy) {
        const accuracy = parseFloat(report.accuracy);
        if (accuracy < 80) {
          insights.push('Significant layout differences detected - check spacing and alignment');
        }
      }
      
      // Screen type insights
      if (report.screenType && report.screenType.type) {
        insights.push(`Identified as ${report.screenType.type} screen with ${Math.round((report.screenType.confidence || 0) * 100)}% confidence`);
      }
      
      // Element count insights
      if (report.formFields && report.formFields.length > 0) {
        insights.push(`Design contains ${report.formFields.length} form fields to validate`);
      }
      
      return insights;
    }
    
    // Generate recommendations based on analysis results
    function generateRecommendations(report) {
      const recommendations = [];
      
      // Field-based recommendations
      if (report.fieldAnalysis && report.fieldAnalysis.fieldMapping) {
        const mapping = report.fieldAnalysis.fieldMapping;
        
        if (mapping.unmatchedFigma && mapping.unmatchedFigma.length > 0) {
          recommendations.push(`Add missing fields: ${mapping.unmatchedFigma.map(f => f.name).join(', ')}`);
        }
        
        if (mapping.unmatchedDetected && mapping.unmatchedDetected.length > 0) {
          recommendations.push('Review and remove unexpected fields that are not in the design');
        }
        
        // Position accuracy recommendations
        if (mapping.accuracyMetrics && mapping.accuracyMetrics.positionAccuracy < 0.8) {
          recommendations.push('Adjust field positions to match Figma design coordinates more closely');
        }
        
        // Size accuracy recommendations
        if (mapping.accuracyMetrics && mapping.accuracyMetrics.dimensionAccuracy < 0.8) {
          recommendations.push('Review field sizes - some elements have incorrect dimensions');
        }
      }
      
      // Color recommendations
      if (report.colorMismatches && report.colorMismatches.length > 0) {
        const majorColorIssues = report.colorMismatches.filter(m => m.severity === 'major');
        if (majorColorIssues.length > 0) {
          recommendations.push('Fix major color deviations to match brand guidelines');
        }
      }
      
      // Layout recommendations
      if (report.accuracy && parseFloat(report.accuracy) < 90) {
        recommendations.push('Improve layout accuracy - check margins, padding, and alignment');
      }
      
      // Spacing recommendations
      if (report.spacingMismatches && report.spacingMismatches.length > 0) {
        recommendations.push('Standardize spacing to match design system specifications');
      }
      
      // General recommendations
      if (recommendations.length === 0) {
        recommendations.push('Implementation matches design well - focus on minor refinements');
      }
      
      return recommendations;
    }

    // Display AI analysis results
    function displayAIAnalysis(report) {
      const confidenceCircle = document.getElementById('aiConfidenceCircle');
      const confidenceDescription = document.getElementById(
        'aiConfidenceDescription'
      );
      const aiConfidenceEl = document.getElementById('aiConfidence');
      const confidenceLabel = document.querySelector(
        '#aiConfidenceCircle .confidence-label'
      );

      // Calculate design match score based on actual data
      let overallMatch = 0;
      let matchComponents = [];
      
      // 1. Field matching score (40% weight)
      if (report.fieldAnalysis && report.fieldAnalysis.fieldMapping) {
        const fieldScore = (report.fieldAnalysis.fieldMapping.overallScore || 0) * 100;
        overallMatch += fieldScore * 0.4;
        matchComponents.push(`Fields: ${Math.round(fieldScore)}%`);
      } else if (report.formFields && report.formFields.length > 0) {
        // No field analysis available but we have form fields
        matchComponents.push(`Fields: Not analyzed`);
      }
      
      // 2. Color matching score (20% weight)
      if (report.figmaProperties?.colors && report.detectedProperties?.colors) {
        const figmaColors = report.figmaProperties.colors.length;
        const detectedColors = report.detectedProperties.colors.length;
        const colorMismatches = report.colorMismatches?.length || 0;
        const colorScore = Math.max(0, (1 - colorMismatches / Math.max(figmaColors, 1)) * 100);
        overallMatch += colorScore * 0.2;
        matchComponents.push(`Colors: ${Math.round(colorScore)}%`);
      }
      
      // 3. Layout accuracy (20% weight)
      if (report.accuracy) {
        const pixelAccuracy = parseFloat(report.accuracy);
        overallMatch += pixelAccuracy * 0.2;
        matchComponents.push(`Layout: ${Math.round(pixelAccuracy)}%`);
      }
      
      // 4. AI comparison results (20% weight)
      if (report.aiAnalysis && report.aiAnalysis.comparisonResults) {
        const aiMatch = report.aiAnalysis.comparisonResults.overallMatch || 0;
        overallMatch += aiMatch * 0.2;
        matchComponents.push(`AI Analysis: ${Math.round(aiMatch)}%`);
      } else {
        // Use basic similarity if no AI comparison
        const similarity = parseFloat(report.similarity || report.accuracy || 0);
        overallMatch += similarity * 0.2;
        matchComponents.push(`Visual: ${Math.round(similarity)}%`);
      }
      
      // Round the overall match
      overallMatch = Math.round(overallMatch);
      
      // Display the calculated match score
      aiConfidenceEl.textContent = overallMatch + '%';
      
      // Update the label to show "match"
      if (confidenceLabel) {
        confidenceLabel.textContent = 'match';
      }
      
      // Update the heading
      const aiConfidenceHeading = document.querySelector('.ai-confidence h3');
      if (aiConfidenceHeading) {
        aiConfidenceHeading.textContent = 'Design Match Score';
      }
      
      // Style circle based on match percentage
      confidenceCircle.classList.remove(
        'confidence-high',
        'confidence-medium',
        'confidence-low'
      );
      
      if (overallMatch >= 85) {
        confidenceCircle.classList.add('confidence-high');
        confidenceDescription.textContent = 
          `Excellent match! (${matchComponents.join(', ')})`;
      } else if (overallMatch >= 70) {
        confidenceCircle.classList.add('confidence-medium');
        confidenceDescription.textContent = 
          `Good match with some deviations. (${matchComponents.join(', ')})`;
      } else {
        confidenceCircle.classList.add('confidence-low');
        confidenceDescription.textContent = 
          `Significant deviations detected. (${matchComponents.join(', ')})`;
      }

      // Update comparison stats - look in multiple places for the data
      const aiAnalysis = report.aiAnalysis || {};
      const detectedProps = report.detectedProperties || {};
      const enhancedAnalysis = detectedProps.enhancedAnalysis || {};
      
      // Count elements from various sources
      const cvElementCount = detectedProps.elements?.length || 
                            detectedProps.detectedElements?.length || 
                            enhancedAnalysis.totalElementsCV || 0;
      
      const aiElementCount = aiAnalysis.detectedElements?.length || 
                            aiAnalysis.elements?.length || 
                            enhancedAnalysis.totalElementsAI || 0;
      
      // Get layout info
      const cvLayoutComplexity = detectedProps.layout?.complexity || 
                                enhancedAnalysis.layoutComplexityCV || 
                                'Not analyzed';
      
      // Extract layout type properly
      let aiLayoutType = 'Not detected';
      if (typeof aiAnalysis.screenType === 'string') {
        aiLayoutType = aiAnalysis.screenType;
      } else if (aiAnalysis.screenType && typeof aiAnalysis.screenType === 'object') {
        aiLayoutType = aiAnalysis.screenType.type || aiAnalysis.screenType.name || 'Complex layout';
      } else if (aiAnalysis.layout?.type) {
        aiLayoutType = aiAnalysis.layout.type;
      } else if (enhancedAnalysis.layoutComplexityAI) {
        aiLayoutType = enhancedAnalysis.layoutComplexityAI;
      }
      
      setTextContent('cvElementCount', cvElementCount);
      setTextContent('aiElementCount', aiElementCount);
      setTextContent('cvLayoutComplexity', cvLayoutComplexity);
      setTextContent('aiLayoutType', aiLayoutType);

      // Display AI insights - generate if not available
      const insightsList = document.getElementById('aiInsightsList');
      let insights = report.insights || [];
      
      // Generate insights based on analysis results
      if (insights.length === 0 && report.fieldAnalysis) {
        insights = generateInsights(report);
      }
      
      if (insights.length > 0) {
        const insightsHtml = insights
          .map((insight) => `<li>${insight}</li>`)
          .join('');
        insightsList.innerHTML = `<ul>${insightsHtml}</ul>`;
      } else {
        insightsList.innerHTML = '<p>No specific AI insights generated.</p>';
      }

      // Display recommendations - generate if not available
      const recommendationsList = document.getElementById(
        'aiRecommendationsList'
      );
      let recommendations = report.recommendations || [];
      
      // Generate recommendations based on analysis results
      if (recommendations.length === 0 && report.fieldAnalysis) {
        recommendations = generateRecommendations(report);
      }
      
      if (recommendations.length > 0) {
        const recommendationsHtml = recommendations
          .map((rec) => `<li>${rec}</li>`)
          .join('');
        recommendationsList.innerHTML = `<ul>${recommendationsHtml}</ul>`;
      } else {
        recommendationsList.innerHTML =
          '<p>No specific AI recommendations generated.</p>';
      }

      // Display detailed AI analysis sections
      displayAIDetailedSections(report);

      // Display raw AI response
      const rawResponse = document.getElementById('aiRawResponse');
      if (report.aiAnalysis && report.aiAnalysis.rawResponse) {
        rawResponse.innerHTML = `<pre>${escapeHtml(
          report.aiAnalysis.rawResponse
        )}</pre>`;
      } else if (report.aiAnalysis && report.aiAnalysis.rawAnalysis) {
        // Fallback for when parsing failed
        rawResponse.innerHTML = `<pre>${escapeHtml(
          report.aiAnalysis.rawAnalysis
        )}</pre>`;
      } else {
        rawResponse.innerHTML = '<pre>No raw AI response available</pre>';
      }
    }

    // Display detailed AI analysis sections
    function displayAIDetailedSections(report) {
      const aiAnalysis = report.aiAnalysis || {};

      // Color analysis - now showing comparison results
      const colorAnalysis = document.getElementById('aiColorAnalysis');
      if (aiAnalysis.colorComparison) {
        let colorContent = '<h5>Color Comparison Results:</h5>';

        // Show expected vs detected colors
        if (
          aiAnalysis.colorComparison.figmaColors &&
          aiAnalysis.colorComparison.detectedColors
        ) {
          colorContent += `<p><strong>Expected Colors (Figma):</strong> ${aiAnalysis.colorComparison.figmaColors.join(
            ', '
          )}</p>`;
          colorContent += `<p><strong>Detected Colors:</strong> ${aiAnalysis.colorComparison.detectedColors.join(
            ', '
          )}</p>`;
        }

        // Show color deviations
        if (
          aiAnalysis.colorComparison.deviations &&
          aiAnalysis.colorComparison.deviations.length > 0
        ) {
          colorContent += `<p class="deviation-header"><strong>⚠️ Color Deviations:</strong></p>`;
          colorContent += '<ul class="deviation-list">';
          aiAnalysis.colorComparison.deviations.forEach((deviation) => {
            colorContent += `<li class="deviation-item">${deviation}</li>`;
          });
          colorContent += '</ul>';
        }

        // Show missing colors
        if (
          aiAnalysis.colorComparison.missingColors &&
          aiAnalysis.colorComparison.missingColors.length > 0
        ) {
          colorContent += `<p><strong>Missing Colors:</strong> ${aiAnalysis.colorComparison.missingColors.join(
            ', '
          )}</p>`;
        }

        // Show extra colors
        if (
          aiAnalysis.colorComparison.extraColors &&
          aiAnalysis.colorComparison.extraColors.length > 0
        ) {
          colorContent += `<p><strong>Extra Colors (not in design):</strong> ${aiAnalysis.colorComparison.extraColors.join(
            ', '
          )}</p>`;
        }

        colorAnalysis.innerHTML = colorContent;
      } else if (aiAnalysis.colors) {
        // Fallback to old format
        let colorContent = '';
        if (aiAnalysis.colors.primary && aiAnalysis.colors.primary.length > 0) {
          colorContent += `<p><strong>Primary Colors:</strong> ${aiAnalysis.colors.primary.join(
            ', '
          )}</p>`;
        }
        if (
          aiAnalysis.colors.secondary &&
          aiAnalysis.colors.secondary.length > 0
        ) {
          colorContent += `<p><strong>Secondary Colors:</strong> ${aiAnalysis.colors.secondary.join(
            ', '
          )}</p>`;
        }
        if (aiAnalysis.colors.issues && aiAnalysis.colors.issues.length > 0) {
          colorContent += `<p><strong>Issues:</strong></p><ul>${aiAnalysis.colors.issues
            .map((issue) => `<li>${issue}</li>`)
            .join('')}</ul>`;
        }
        colorAnalysis.innerHTML =
          colorContent || '<p>No specific color insights from AI analysis.</p>';
      } else {
        colorAnalysis.innerHTML = '<p>No color analysis available from AI.</p>';
      }

      // Spacing analysis - now showing comparison results
      const spacingAnalysis = document.getElementById('aiSpacingAnalysis');
      if (aiAnalysis.spacingComparison) {
        let spacingContent = '<h5>Spacing Comparison Results:</h5>';

        // Show expected vs detected spacing
        if (
          aiAnalysis.spacingComparison.figmaSpacing &&
          aiAnalysis.spacingComparison.detectedSpacing
        ) {
          const figmaSpacing = aiAnalysis.spacingComparison.figmaSpacing;
          const detectedSpacing = aiAnalysis.spacingComparison.detectedSpacing;

          spacingContent += '<div class="spacing-comparison-grid">';
          spacingContent += '<div><strong>Expected (Figma):</strong>';
          if (figmaSpacing.padding) {
            spacingContent += `<br>Padding: ${JSON.stringify(
              figmaSpacing.padding
            )}`;
          }
          if (figmaSpacing.gap) {
            spacingContent += `<br>Gap: ${figmaSpacing.gap}px`;
          }
          spacingContent += '</div>';

          spacingContent += '<div><strong>Detected:</strong>';
          if (detectedSpacing.padding) {
            spacingContent += `<br>Padding: ${JSON.stringify(
              detectedSpacing.padding
            )}`;
          }
          if (detectedSpacing.gaps && detectedSpacing.gaps.length > 0) {
            spacingContent += `<br>Gaps: ${detectedSpacing.gaps.join(
              'px, '
            )}px`;
          }
          spacingContent += '</div></div>';
        }

        // Show spacing deviations
        if (
          aiAnalysis.spacingComparison.deviations &&
          aiAnalysis.spacingComparison.deviations.length > 0
        ) {
          spacingContent += `<p class="deviation-header"><strong>⚠️ Spacing Deviations:</strong></p>`;
          spacingContent += '<ul class="deviation-list">';
          aiAnalysis.spacingComparison.deviations.forEach((deviation) => {
            spacingContent += `<li class="deviation-item">${deviation}</li>`;
          });
          spacingContent += '</ul>';
        }

        spacingAnalysis.innerHTML = spacingContent;
      } else if (aiAnalysis.spacing) {
        // Fallback to old format
        let spacingContent = '';
        if (
          aiAnalysis.spacing.patterns &&
          aiAnalysis.spacing.patterns.length > 0
        ) {
          spacingContent += `<p><strong>Patterns:</strong> ${aiAnalysis.spacing.patterns.join(
            ', '
          )}</p>`;
        }
        if (aiAnalysis.spacing.gaps && aiAnalysis.spacing.gaps.length > 0) {
          spacingContent += `<p><strong>Common Gaps:</strong> ${aiAnalysis.spacing.gaps.join(
            'px, '
          )}px</p>`;
        }
        if (aiAnalysis.spacing.issues && aiAnalysis.spacing.issues.length > 0) {
          spacingContent += `<p><strong>Issues:</strong></p><ul>${aiAnalysis.spacing.issues
            .map((issue) => `<li>${issue}</li>`)
            .join('')}</ul>`;
        }
        spacingAnalysis.innerHTML =
          spacingContent ||
          '<p>No specific spacing insights from AI analysis.</p>';
      } else {
        spacingAnalysis.innerHTML =
          '<p>No spacing analysis available from AI.</p>';
      }

      // Typography analysis
      const typographyAnalysis = document.getElementById(
        'aiTypographyAnalysis'
      );
      if (aiAnalysis.typography) {
        let typographyContent = '';
        if (
          aiAnalysis.typography.fonts &&
          aiAnalysis.typography.fonts.length > 0
        ) {
          typographyContent += `<p><strong>Detected Fonts:</strong> ${aiAnalysis.typography.fonts.join(
            ', '
          )}</p>`;
        }
        if (
          aiAnalysis.typography.sizes &&
          aiAnalysis.typography.sizes.length > 0
        ) {
          typographyContent += `<p><strong>Font Sizes:</strong> ${aiAnalysis.typography.sizes.join(
            'px, '
          )}px</p>`;
        }
        if (aiAnalysis.typography.hierarchy) {
          typographyContent += `<p><strong>Typography Hierarchy:</strong> ${aiAnalysis.typography.hierarchy}</p>`;
        }
        if (
          aiAnalysis.typography.issues &&
          aiAnalysis.typography.issues.length > 0
        ) {
          typographyContent += `<p><strong>Issues:</strong></p><ul>${aiAnalysis.typography.issues
            .map((issue) => `<li>${issue}</li>`)
            .join('')}</ul>`;
        }
        typographyAnalysis.innerHTML =
          typographyContent ||
          '<p>No specific typography insights from AI analysis.</p>';
      } else {
        typographyAnalysis.innerHTML =
          '<p>No typography analysis available from AI.</p>';
      }

      // Accessibility analysis
      const accessibilityAnalysis = document.getElementById(
        'aiAccessibilityAnalysis'
      );
      if (aiAnalysis.accessibility) {
        let accessibilityContent = '';
        if (aiAnalysis.accessibility.contrast) {
          accessibilityContent += `<p><strong>Color Contrast:</strong> ${aiAnalysis.accessibility.contrast}</p>`;
        }
        if (
          aiAnalysis.accessibility.issues &&
          aiAnalysis.accessibility.issues.length > 0
        ) {
          accessibilityContent += `<p><strong>Accessibility Issues:</strong></p><ul>${aiAnalysis.accessibility.issues
            .map((issue) => `<li>${issue}</li>`)
            .join('')}</ul>`;
        }
        accessibilityAnalysis.innerHTML =
          accessibilityContent ||
          '<p>No specific accessibility insights from AI analysis.</p>';
      } else {
        accessibilityAnalysis.innerHTML =
          '<p>No accessibility analysis available from AI.</p>';
      }
    }

    // Download report
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => {
        if (currentReport) {
          generateHTMLReport(currentReport);
        }
      });
    }

    function generateHTMLReport(report) {
      const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>UI/UX Comparison Report - ${new Date(
      report.timestamp
    ).toLocaleString()}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f7fa;
        }
        .header {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            margin-bottom: 30px;
            text-align: center;
        }
        .header h1 {
            color: #2c3e50;
            margin-bottom: 10px;
        }
        .timestamp {
            color: #7f8c8d;
        }
        .summary {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            margin-bottom: 30px;
        }
        .metrics {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }
        .metric {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            text-align: center;
        }
        .metric-label {
            display: block;
            font-size: 14px;
            color: #7f8c8d;
            margin-bottom: 5px;
        }
        .metric-value {
            display: block;
            font-size: 28px;
            font-weight: bold;
            color: #2c3e50;
        }
        .similarity-high { color: #27ae60 !important; }
        .similarity-medium { color: #f39c12 !important; }
        .similarity-low { color: #e74c3c !important; }
        .images {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .image-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 30px;
            margin-top: 20px;
        }
        .image-item {
            text-align: center;
        }
        .image-item h3 {
            margin-bottom: 15px;
            color: #34495e;
        }
        .image-item img {
            max-width: 100%;
            height: auto;
            border: 1px solid #e0e0e0;
            border-radius: 5px;
        }
        .analysis {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            margin-top: 30px;
        }
        .analysis h2 {
            color: #2c3e50;
            margin-bottom: 20px;
        }
        .analysis-item {
            margin-bottom: 15px;
            padding: 15px;
            background: #f8f9fa;
            border-radius: 5px;
        }
        .footer {
            text-align: center;
            margin-top: 40px;
            color: #7f8c8d;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>UI/UX Pixel Perfect Comparison Report</h1>
        <p class="timestamp">Generated on: ${new Date(
          report.timestamp
        ).toLocaleString()}</p>
    </div>
    
    <div class="summary">
        <h2>Summary</h2>
        <div class="metrics">
            <div class="metric">
                <span class="metric-label">Overall Similarity</span>
                <span class="metric-value ${
                  parseFloat(report.similarity) >= 95
                    ? 'similarity-high'
                    : parseFloat(report.similarity) >= 80
                    ? 'similarity-medium'
                    : 'similarity-low'
                }">${report.similarity}%</span>
            </div>
            <div class="metric">
                <span class="metric-label">Total Pixels Analyzed</span>
                <span class="metric-value">${report.totalPixels.toLocaleString()}</span>
            </div>
            <div class="metric">
                <span class="metric-label">Matched Pixels</span>
                <span class="metric-value">${report.matchedPixels.toLocaleString()}</span>
            </div>
            <div class="metric">
                <span class="metric-label">Different Pixels</span>
                <span class="metric-value">${report.diffPixels.toLocaleString()}</span>
            </div>
        </div>
    </div>
    
    <div class="images">
        <h2>Visual Comparison</h2>
        <div class="image-grid">
            <div class="image-item">
                <h3>Figma Design</h3>
                <img src="${window.location.origin}${
        report.figmaImage
      }" alt="Figma Design">
            </div>
            <div class="image-item">
                <h3>Rendered Screen</h3>
                <img src="${window.location.origin}${
        report.renderedImage
      }" alt="Rendered Screen">
            </div>
            <div class="image-item" style="grid-column: 1 / -1;">
                <h3>UI Differences Visualization</h3>
                <img src="${window.location.origin}${
        report.overlayImage || report.diffImage
      }" alt="UI Differences Visualization" style="max-width: 800px; margin: 0 auto; display: block; border: 2px solid #e74c3c;">
                <p style="font-size: 14px; color: #7f8c8d; margin-top: 10px;">
                    Red boxes highlight UI regions with differences • ${
                      report.diffRegions || 0
                    } regions detected
                </p>
            </div>
        </div>
    </div>
    
    <div class="analysis">
        <h2>Analysis & Recommendations</h2>
        ${generateAnalysis(report)}
    </div>
    
    <div class="footer">
        <p>Report ID: ${report.id} | Dimensions: ${report.dimensions.width}x${
        report.dimensions.height
      }px</p>
    </div>
</body>
</html>
        `;

      // Create and download the report
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `uiux-report-${report.id}.html`;
      a.click();
      URL.revokeObjectURL(url);
    }

    function generateAnalysis(report) {
      const similarity = parseFloat(report.similarity);
      let analysis = '';

      if (similarity >= 95) {
        analysis += `
                <div class="analysis-item">
                    <strong>Excellent Match!</strong> The implementation achieves ${similarity}% similarity with the design.
                    This indicates a pixel-perfect or near-perfect implementation.
                </div>
            `;
      } else if (similarity >= 80) {
        analysis += `
                <div class="analysis-item">
                    <strong>Good Match</strong> The implementation achieves ${similarity}% similarity with the design.
                    There are some noticeable differences that should be reviewed.
                </div>
            `;
      } else {
        analysis += `
                <div class="analysis-item">
                    <strong>Significant Differences</strong> The implementation achieves only ${similarity}% similarity with the design.
                    Major revisions are recommended to match the original design.
                </div>
            `;
      }

      analysis += `
            <div class="analysis-item">
                <strong>UI Analysis:</strong> Found ${
                  report.diffRegions || 0
                } UI regions with differences affecting ${report.diffPixels.toLocaleString()} pixels total.
            </div>
        `;

      if (report.diffPixels > 0) {
        analysis += `
                <div class="analysis-item">
                    <strong>Recommendations:</strong>
                    <ul style="margin: 10px 0 0 20px;">
                        ${
                          report.diffRegions > 5
                            ? '<li>Multiple UI components need attention - prioritize the largest difference regions</li>'
                            : ''
                        }
                        ${
                          report.diffRegions > 0
                            ? '<li>Check the highlighted regions for missing elements, wrong colors, or layout shifts</li>'
                            : ''
                        }
                        ${
                          similarity < 90
                            ? '<li>Verify component spacing and alignment matches the design grid</li>'
                            : ''
                        }
                        ${
                          similarity < 85
                            ? '<li>Review text styling (font family, size, weight, color) in affected regions</li>'
                            : ''
                        }
                        <li>Focus on the red-boxed areas in the visualization above</li>
                        <li>Use browser DevTools to inspect and adjust the highlighted components</li>
                    </ul>
                </div>
            `;
      }

      return analysis;
    }

    // Display JSON preview
    function displayJSONPreview(json) {
      console.log('displayJSONPreview called with:', json);
      const preview = document.getElementById('jsonPreview');
      if (!preview) {
        console.error('JSON preview element not found');
        return;
      }

      console.log('Preview element found:', preview);

      // Start with the raw JSON display
      let html = '<div class="json-properties">';

      // Add raw JSON display first
      html += '<details style="margin-bottom: 10px;">';
      html +=
        '<summary style="cursor: pointer; font-weight: bold;">View Fetched JSON</summary>';
      html +=
        '<pre style="max-height: 300px; overflow-y: auto; background: #f5f5f5; padding: 10px; border-radius: 5px; font-size: 12px;">';
      html += escapeHtml(JSON.stringify(json, null, 2));
      html += '</pre>';
      html += '</details>';

      try {
        const properties = extractDesignProperties(json);
        console.log('Extracted properties:', properties);

        // Add extracted properties display
        if (properties.colors && properties.colors.length > 0) {
          html += '<strong>Colors:</strong> ';
          html += properties.colors
            .slice(0, 3)
            .map((c) => {
              const colorValue =
                typeof c === 'string' ? c : c.value || c.hex || '#000000';
              return `<span style="background: ${colorValue}; padding: 2px 8px; margin: 2px; border-radius: 3px; color: ${
                isLightColor(colorValue) ? '#000' : '#fff'
              };">${colorValue}</span>`;
            })
            .join('');
          if (properties.colors.length > 3) {
            html += ` <small>+${properties.colors.length - 3} more</small>`;
          }
          html += '<br>';
        }
        if (properties.typography) {
          // Check if typography is an array (from server) or object (from client extraction)
          if (Array.isArray(properties.typography)) {
            html += '<strong>Typography:</strong><br>';
            properties.typography.forEach((typo, index) => {
              const fontFamily = typo.fontFamily || 'Unknown';
              const fontSize = typo.fontSize || 'Unknown';
              html += `<span style="margin-left: 10px;">• ${fontFamily} ${fontSize}px</span><br>`;
            });
          } else {
            // Handle object format
            html += `<strong>Font:</strong> ${
              properties.typography.fontFamily || 'Not specified'
            }<br>`;
            html += `<strong>Size:</strong> ${
              properties.typography.fontSize || 'Not specified'
            }<br>`;
          }
        }
      } catch (error) {
        console.error('Error extracting design properties:', error);
        html +=
          '<p style="color: #e74c3c;">Error extracting properties: ' +
          error.message +
          '</p>';
      }

      html += '</div>';

      // Always set the HTML, even if there was an error
      preview.innerHTML = html;
      console.log('JSON preview updated');
    }

    // Extract design properties from Figma JSON
    function extractDesignProperties(json) {
      const properties = {
        colors: [],
        typography: {},
        spacing: {},
        dimensions: {},
      };

      // Helper function to traverse nested nodes
      function traverseNode(node) {
        // Extract colors (background, fills, strokes)
        if (node.backgroundColor) {
          const bgHex = rgbToHex(node.backgroundColor);
          if (!properties.colors.includes(bgHex)) {
            properties.colors.push(bgHex);
          }
        }

        if (node.fills && Array.isArray(node.fills)) {
          node.fills.forEach((fill) => {
            if (fill.visible !== false && fill.color) {
              const hex = rgbToHex(fill.color);
              if (!properties.colors.includes(hex)) {
                properties.colors.push(hex);
              }
            } else if (
              fill.visible !== false &&
              fill.type === 'SOLID' &&
              fill.opacity !== 0
            ) {
              // Sometimes color is directly in the fill object
              if (
                fill.r !== undefined &&
                fill.g !== undefined &&
                fill.b !== undefined
              ) {
                const hex = rgbToHex({ r: fill.r, g: fill.g, b: fill.b });
                if (!properties.colors.includes(hex)) {
                  properties.colors.push(hex);
                }
              }
            }
          });
        }

        if (node.strokes && Array.isArray(node.strokes)) {
          node.strokes.forEach((stroke) => {
            if (stroke.visible !== false && stroke.color) {
              const hex = rgbToHex(stroke.color);
              if (!properties.colors.includes(hex)) {
                properties.colors.push(hex);
              }
            }
          });
        }

        // Extract typography for TEXT nodes
        if (node.type === 'TEXT') {
          if (node.style) {
            properties.typography = {
              fontFamily: node.style.fontFamily,
              fontSize: node.style.fontSize,
              fontWeight: node.style.fontWeight,
              lineHeight:
                node.style.lineHeightPx || node.style.lineHeightPercent,
              letterSpacing: node.style.letterSpacing,
              textAlign: node.style.textAlignHorizontal,
            };
          }

          // Get text color from characters
          if (node.characters) {
            properties.typography.text = node.characters;
          }
        }

        // Extract dimensions from absoluteBoundingBox
        if (node.absoluteBoundingBox && !properties.dimensions.width) {
          properties.dimensions = {
            width: Math.round(node.absoluteBoundingBox.width),
            height: Math.round(node.absoluteBoundingBox.height),
          };
        }

        // Extract padding
        if (node.paddingLeft !== undefined) {
          properties.spacing = {
            paddingTop: node.paddingTop || 0,
            paddingRight: node.paddingRight || 0,
            paddingBottom: node.paddingBottom || 0,
            paddingLeft: node.paddingLeft || 0,
          };
        }

        // Traverse children
        if (node.children && Array.isArray(node.children)) {
          node.children.forEach((child) => traverseNode(child));
        }
      }

      // Start traversal
      traverseNode(json);

      return properties;
    }

    // Convert Figma RGB to hex
    function rgbToHex(color) {
      if (!color) return '#000000';
      const r = Math.round(color.r * 255);
      const g = Math.round(color.g * 255);
      const b = Math.round(color.b * 255);
      return (
        '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')
      );
    }

    // Check if color is light or dark
    function isLightColor(hex) {
      const color = hex.substring(1); // Remove #
      const r = parseInt(color.substr(0, 2), 16);
      const g = parseInt(color.substr(2, 2), 16);
      const b = parseInt(color.substr(4, 2), 16);
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      return brightness > 155;
    }

    // Display specification comparison
    function displaySpecComparison(report) {
      const specDisplay = document.getElementById('specDisplay');
      const detectedDisplay = document.getElementById('detectedDisplay');

      // Display Figma specifications
      let specHtml = '';
      if (report.figmaProperties) {
        const props = report.figmaProperties;

        // Colors
        if (props.colors && props.colors.length > 0) {
          specHtml += '<div class="property-group">';
          specHtml += '<h5>Colors</h5>';
          props.colors.forEach((color, index) => {
            // Handle both string colors and color objects
            const colorValue =
              typeof color === 'string'
                ? color
                : color.value || color.hex || '#000000';
            const colorName = color.property || `Color ${index + 1}`;

            specHtml += `<div class="property-item">
                        <span class="property-name">${colorName}</span>
                        <span class="property-value" style="background: ${colorValue}; padding: 2px 8px; color: ${
              isLightColor(colorValue) ? '#000' : '#fff'
            };">${colorValue}</span>
                    </div>`;
          });
          specHtml += '</div>';
        }

        // Typography
        if (props.typography) {
          specHtml += '<div class="property-group">';
          specHtml += '<h5>Typography</h5>';

          // Check if typography is an array or object
          if (Array.isArray(props.typography)) {
            // Handle array of typography objects
            props.typography.forEach((typo, index) => {
              if (typo) {
                const fontFamily = typo.fontFamily || 'Unknown';
                const fontSize = typo.fontSize || 'Unknown';
                const fontWeight = typo.fontWeight || 'normal';
                const lineHeight = typo.lineHeight || 'normal';

                specHtml += `<div class="property-item">
                                <span class="property-name">Text Style ${
                                  index + 1
                                }</span>
                                <span class="property-value">${fontFamily} ${fontSize}px (${fontWeight})</span>
                            </div>`;
              }
            });
          } else if (typeof props.typography === 'object') {
            // Handle typography object
            Object.entries(props.typography).forEach(([key, value]) => {
              if (value) {
                specHtml += `<div class="property-item">
                                <span class="property-name">${key}</span>
                                <span class="property-value">${value}</span>
                            </div>`;
              }
            });
          }
          specHtml += '</div>';
        }
      }

      specDisplay.innerHTML = specHtml || '<p>No specifications found</p>';

      // Display detected properties
      let detectedHtml = '';
      if (report.detectedProperties) {
        const detected = report.detectedProperties;

        // Colors
        if (detected.colors && detected.colors.length > 0) {
          detectedHtml += '<div class="property-group">';
          detectedHtml += '<h5>Detected Colors</h5>';
          detected.colors.forEach((color, index) => {
            detectedHtml += `<div class="property-item">
                        <span class="property-name">Color ${index + 1}</span>
                        <span class="property-value" style="background: ${
                          color.hex
                        }; padding: 2px 8px;">${color.hex}</span>
                    </div>`;
          });
          detectedHtml += '</div>';
        }
      }

      detectedDisplay.innerHTML =
        detectedHtml || '<p>Analyzing screenshot...</p>';
    }

    // Display detailed analysis
    function displayDetailedAnalysis(report) {
      // Display ALL color comparisons (not just mismatches)
      let colorComparisonHtml = '';

      if (
        report.figmaProperties &&
        report.figmaProperties.colors &&
        report.detectedProperties &&
        report.detectedProperties.colors
      ) {
        // Show all Figma colors with their closest matches
        report.figmaProperties.colors.forEach((figmaColor, index) => {
          const colorName = figmaColor.property || `Color ${index + 1}`;
          const expectedColor = figmaColor.value || figmaColor;

          // Find if there's a mismatch for this color
          const mismatch = report.colorMismatches
            ? report.colorMismatches.find(
                (m) => m.property === figmaColor.property
              )
            : null;

          // Get the actual detected color
          let detectedColor = '#cccccc'; // Default gray
          if (mismatch) {
            detectedColor =
              mismatch.actual === 'Not detected' ? '#cccccc' : mismatch.actual;
          } else if (report.detectedProperties.colors[index]) {
            detectedColor = report.detectedProperties.colors[index].hex;
          }

          let matchStatus = '';
          if (mismatch) {
            const deltaE = mismatch.deltaE ? ` - ΔE: ${mismatch.deltaE}` : '';
            if (mismatch.severity === 'major') {
              matchStatus = ` (Major Difference${deltaE})`;
            } else {
              matchStatus = ` (Minor Difference${deltaE})`;
            }
          } else {
            matchStatus = ' (Perfect Match)';
          }

          colorComparisonHtml += `
                    <div class="color-comparison-item">
                        <h4>${colorName}${matchStatus}</h4>
                        <div class="color-swatches">
                            <div class="color-swatch">
                                <div class="swatch-color" style="background: ${expectedColor};"></div>
                                <span class="swatch-label">Expected</span>
                                <span class="swatch-value">${expectedColor}</span>
                            </div>
                            <div class="color-swatch">
                                <div class="swatch-color" style="background: ${detectedColor};"></div>
                                <span class="swatch-label">Detected</span>
                                <span class="swatch-value">${detectedColor}</span>
                            </div>
                        </div>
                    </div>
                `;
        });

        // Also show any detected colors that weren't in the Figma spec
        const figmaColorCount = report.figmaProperties.colors.length;
        if (report.detectedProperties.colors.length > figmaColorCount) {
          for (
            let i = figmaColorCount;
            i < report.detectedProperties.colors.length;
            i++
          ) {
            const detectedColor = report.detectedProperties.colors[i];
            colorComparisonHtml += `
                        <div class="color-comparison-item">
                            <h4>${detectedColor.property} (Extra)</h4>
                            <div class="color-swatches">
                                <div class="color-swatch">
                                    <div class="swatch-color" style="background: #ffffff;"></div>
                                    <span class="swatch-label">Expected</span>
                                    <span class="swatch-value">Not specified</span>
                                </div>
                                <div class="color-swatch">
                                    <div class="swatch-color" style="background: ${detectedColor.hex};"></div>
                                    <span class="swatch-label">Detected</span>
                                    <span class="swatch-value">${detectedColor.hex}</span>
                                </div>
                            </div>
                        </div>
                    `;
          }
        }
      } else {
        colorComparisonHtml = '<p>Color analysis not available</p>';
      }

      setInnerHTML('colorComparison', colorComparisonHtml);

      // Display property mismatches (excluding colors which are shown above)
      let mismatchHtml = '';

      if (report.propertyMismatches && report.propertyMismatches.length > 0) {
        // Filter out color mismatches since they're shown in the color comparison section
        const nonColorMismatches = report.propertyMismatches.filter(
          (m) => !m.property.toLowerCase().includes('color')
        );

        if (nonColorMismatches.length > 0) {
          nonColorMismatches.forEach((mismatch) => {
            const severity = mismatch.severity || 'major';
            mismatchHtml += `
                        <div class="mismatch-item ${
                          severity === 'minor' ? 'minor' : ''
                        }">
                            <div class="mismatch-property">${
                              mismatch.property
                            }</div>
                            <div class="mismatch-values">
                                <div class="expected-value">
                                    <div class="value-label">Expected</div>
                                    <div class="value-content">${
                                      mismatch.expected
                                    }</div>
                                </div>
                                <div class="actual-value">
                                    <div class="value-label">Actual</div>
                                    <div class="value-content">${
                                      mismatch.actual || 'Not detected'
                                    }</div>
                                </div>
                            </div>
                        </div>
                    `;
          });
        } else {
          mismatchHtml = '<p>No non-color property mismatches found</p>';
        }
      } else {
        mismatchHtml = '<p>No property mismatches found</p>';
      }

      setInnerHTML('propertyMismatches', mismatchHtml);

      // Update category counts
      setTextContent('colorDiffCount', report.colorMismatches?.length || '0');
      setTextContent(
        'spacingDiffCount',
        report.spacingMismatches?.length || '0'
      );
      setTextContent('textDiffCount', report.textMismatches?.length || '0');
      setTextContent('sizeDiffCount', report.sizeMismatches?.length || '0');
    }

    // Parse Figma URL to extract file key and node ID
    function parseFigmaUrl(url) {
      try {
        // Example URLs:
        // https://www.figma.com/file/ABC123/File-Name?node-id=1:2
        // https://www.figma.com/file/ABC123/File-Name?node-id=1-2
        // https://www.figma.com/design/ABC123/File-Name?node-id=1-2
        // https://www.figma.com/file/ABC123/File-Name
        // https://api.figma.com/file/ABC123 (API URL format)
        // https://api.figma.com/v1/files/ABC123 (API URL format)

        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');

        // Check for API URL format
        if (urlObj.hostname === 'api.figma.com') {
          // Handle both /file/ABC123 and /v1/files/ABC123 formats
          let fileKey = null;
          
          if (pathParts[1] === 'file' && pathParts[2]) {
            fileKey = pathParts[2];
          } else if (pathParts[1] === 'v1' && pathParts[2] === 'files' && pathParts[3]) {
            fileKey = pathParts[3];
          }
          
          if (fileKey) {
            // Extract node ID from query params if present
            let nodeId = urlObj.searchParams.get('node-id') || urlObj.searchParams.get('ids');
            if (nodeId) {
              nodeId = nodeId.replace(':', '-');
            }
            return { fileKey, nodeId };
          }
        }

        // Check for regular Figma web URLs (/file/ and /design/ formats)
        if (
          (pathParts[1] !== 'file' && pathParts[1] !== 'design') ||
          !pathParts[2]
        ) {
          return null;
        }

        const fileKey = pathParts[2];
        let nodeId = null;

        // Check for node-id in URL params
        const nodeIdParam = urlObj.searchParams.get('node-id');
        if (nodeIdParam) {
          // Convert node ID format (1:2 or 1-2 to 1-2)
          nodeId = nodeIdParam.replace(':', '-');
        }

        return { fileKey, nodeId };
      } catch (error) {
        return null;
      }
    }

    // Fetch Figma design using API (via server proxy)
    async function fetchFigmaDesign(fileKey, nodeId, token, useHeaderAuth = false, useProxy = false) {
      try {
        // Always send token via header
        const headers = {
          'X-Figma-Token': token
        };
        
        // Build query parameters
        const params = new URLSearchParams({
          fileKey: fileKey,
          useProxy: useProxy
        });
        
        // Add nodeId if present
        if (nodeId) {
          params.append('nodeId', nodeId);
        }
        
        const response = await fetch(`/figma/fetch?${params.toString()}`, {
          method: 'GET',
          headers: headers
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to fetch Figma design');
        }

        const data = await response.json();

        // Return the full response including properties and formFields
        if (data.design || data.properties || data.formFields) {
          return data;
        }

        throw new Error('No design data found');
      } catch (error) {
        console.error('Figma API error:', error);
        throw error;
      }
    }

    // Display field analysis
    function displayFieldAnalysis(report) {
      // Screen type
      if (report.screenType) {
        setTextContent('screenType', report.screenType.type || 'unknown');
        setTextContent(
          'screenTypeConfidence',
          `${Math.round((report.screenType.confidence || 0) * 100)}% confidence`
        );

        // Display indicators
        const indicatorsDiv = document.getElementById('screenTypeIndicators');
        if (
          report.screenType.indicators &&
          report.screenType.indicators.length > 0
        ) {
          indicatorsDiv.innerHTML =
            '<ul>' +
            report.screenType.indicators
              .map((ind) => `<li>${ind}</li>`)
              .join('') +
            '</ul>';
        } else {
          indicatorsDiv.innerHTML = '';
        }
      }

      // Field summary
      if (report.fieldAnalysis) {
        const fieldAnalysis = report.fieldAnalysis;
        const fieldMapping = fieldAnalysis.fieldMapping;

        // Update summary counts
        setTextContent('expectedFieldCount', report.formFields?.length || '0');
        setTextContent(
          'detectedFieldCount',
          fieldAnalysis.detectedFields?.length || '0'
        );

        if (fieldMapping && fieldMapping.summary) {
          setTextContent(
            'fieldMatchRate',
            `${Math.round(fieldMapping.summary.matchRate * 100)}%`
          );
          setTextContent(
            'fieldScore',
            `${Math.round(fieldMapping.overallScore * 100)}%`
          );
        }

        // Display field mappings
        displayFieldMappings(fieldAnalysis);

        // Display unmatched fields
        displayUnmatchedFields(fieldAnalysis);
      } else {
        // No field analysis available, update counts from regular data
        setTextContent('expectedFieldCount', report.formFields?.length || '0');
        setTextContent('detectedFieldCount', '0');
      }

      // Display field detection comparison if available
      if (
        report.fieldAnalysis &&
        report.fieldAnalysis.fieldDetectionComparison
      ) {
        displayFieldDetectionComparison(
          report.fieldAnalysis.fieldDetectionComparison
        );
      }

      // Display field groups
      displayFieldGroups(report.fieldGroups);
    }

    function displayFieldMappings(fieldAnalysis) {
      const mappingsList = document.getElementById('fieldMappingsList');

      if (
        !fieldAnalysis.fieldComparisons ||
        !fieldAnalysis.fieldComparisons.comparisons ||
        fieldAnalysis.fieldComparisons.comparisons.length === 0
      ) {
        mappingsList.innerHTML =
          '<p style="color: #666;">No field mappings available.</p>';
        return;
      }

      const mappingsHtml = fieldAnalysis.fieldComparisons.comparisons
        .map((comparison) => {
          const scoreClass =
            comparison.comparison.matchQuality === 'excellent'
              ? 'score-excellent'
              : comparison.comparison.matchQuality === 'good'
              ? 'score-good'
              : comparison.comparison.matchQuality === 'fair'
              ? 'score-fair'
              : 'score-poor';

          const differencesHtml = comparison.differences
            .map(
              (diff) => `
                <div class="diff-item">
                    <span class="diff-property">${diff.property}:</span>
                    <div class="diff-values">
                        <span class="expected-value">${escapeHtml(
                          diff.expected
                        )}</span>
                        <span class="diff-arrow">→</span>
                        <span class="detected-value">${escapeHtml(
                          diff.detected
                        )}</span>
                    </div>
                </div>
            `
            )
            .join('');

          return `
                <div class="field-mapping-item">
                    <div class="field-mapping-header">
                        <div class="field-info">
                            <span class="field-type">${
                              comparison.fieldType
                            }</span>
                            <span class="field-name">${escapeHtml(
                              comparison.fieldName
                            )}</span>
                        </div>
                        <div class="match-score">
                            <span class="score-badge ${scoreClass}">
                                ${Math.round(
                                  comparison.matchScore * 100
                                )}% match
                            </span>
                        </div>
                    </div>
                    ${
                      differencesHtml
                        ? `<div class="field-differences">${differencesHtml}</div>`
                        : ''
                    }
                </div>
            `;
        })
        .join('');

      mappingsList.innerHTML = mappingsHtml;
    }

    function displayUnmatchedFields(fieldAnalysis) {
      const unmatchedFigmaDiv = document.getElementById('unmatchedFigmaFields');
      const unmatchedDetectedDiv = document.getElementById(
        'unmatchedDetectedFields'
      );

      // Unmatched Figma fields
      if (
        fieldAnalysis.fieldComparisons &&
        fieldAnalysis.fieldComparisons.unmatchedFigmaFields &&
        fieldAnalysis.fieldComparisons.unmatchedFigmaFields.length > 0
      ) {
        const figmaHtml = fieldAnalysis.fieldComparisons.unmatchedFigmaFields
          .map(
            (field) => `
                <div class="unmatched-item">
                    <strong>${escapeHtml(field.name)}</strong> (${field.type})
                </div>
            `
          )
          .join('');
        unmatchedFigmaDiv.innerHTML = figmaHtml;
      } else {
        unmatchedFigmaDiv.innerHTML =
          '<p style="color: #27ae60;">All expected fields detected!</p>';
      }

      // Unmatched detected fields
      if (
        fieldAnalysis.fieldComparisons &&
        fieldAnalysis.fieldComparisons.unmatchedDetectedFields &&
        fieldAnalysis.fieldComparisons.unmatchedDetectedFields.length > 0
      ) {
        const detectedHtml =
          fieldAnalysis.fieldComparisons.unmatchedDetectedFields
            .map(
              (field, index) => `
                <div class="unmatched-item">
                    Unexpected ${field.type || 'field'} at position (${
                field.bounds?.x || 0
              }, ${field.bounds?.y || 0})
                </div>
            `
            )
            .join('');
        unmatchedDetectedDiv.innerHTML = detectedHtml;
      } else {
        unmatchedDetectedDiv.innerHTML =
          '<p style="color: #27ae60;">No unexpected fields detected.</p>';
      }
    }

    function displayFieldDetectionComparison(comparison) {
      // Update accuracy metrics
      if (comparison && comparison.accuracyMetrics) {
        const metrics = comparison.accuracyMetrics;

        // Update overall accuracy
        updateFieldAccuracyBar('fieldOverall', metrics.overallAccuracy);

        // Update position accuracy
        updateFieldAccuracyBar('fieldPosition', metrics.positionAccuracy);

        // Update type accuracy
        updateFieldAccuracyBar('fieldType', metrics.typeAccuracy);

        // Update dimension accuracy
        updateFieldAccuracyBar('fieldDimension', metrics.dimensionAccuracy);
      }
    }

    function updateFieldAccuracyBar(type, value) {
      const percentage = Math.round(value * 100);
      const bar = document.getElementById(`${type}AccuracyBar`);
      const valueSpan = document.getElementById(`${type}AccuracyValue`);

      if (bar && valueSpan) {
        bar.style.width = `${percentage}%`;
        valueSpan.textContent = `${percentage}%`;

        // Color based on accuracy
        if (percentage >= 80) {
          bar.style.background = '#27ae60';
        } else if (percentage >= 60) {
          bar.style.background = '#f39c12';
        } else {
          bar.style.background = '#e74c3c';
        }
        
        // Add animation
        bar.style.transition = 'width 0.5s ease-in-out';
      }
    }

    function displayFieldGroups(fieldGroups) {
      const groupsList = document.getElementById('fieldGroupsList');

      if (!fieldGroups || fieldGroups.length === 0) {
        groupsList.innerHTML =
          '<p style="color: #666;">No field groups detected.</p>';
        return;
      }

      const groupsHtml = fieldGroups
        .map(
          (group) => `
            <div class="field-group-item">
                <div class="field-group-header">${escapeHtml(
                  group.containerName
                )}</div>
                <div class="field-group-fields">
                    ${
                      Array.isArray(group.fields)
                        ? group.fields
                            .map(
                              (field) =>
                                `<span class="field-chip">${escapeHtml(
                                  field.name
                                )} (${field.type})</span>`
                            )
                            .join('')
                        : ''
                    }
                </div>
            </div>
        `
        )
        .join('');

      groupsList.innerHTML = groupsHtml;
    }

    // Field Detection Tool Handlers

    // Store main screenshot file reference
    let mainScreenshotFile = null;

    // Track when main screenshot is selected
    const codeScreenshotElement = document.getElementById('codeScreenshot');
    if (codeScreenshotElement) {
      codeScreenshotElement.addEventListener('change', function (e) {
        mainScreenshotFile = e.target.files[0];
        // Let original handler also run
      });
    }

    // Handle "Use Code Output Screenshot" button
    const useMainScreenshotBtn = document.getElementById(
      'useMainScreenshotBtn'
    );

    if (useMainScreenshotBtn) {
      useMainScreenshotBtn.addEventListener('click', () => {
        if (!mainScreenshotFile) {
          alert('Please upload a code output screenshot first');
          return;
        }

        // Set the file to the detection input
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(mainScreenshotFile);
        detectionImage.files = dataTransfer.files;

        // Preview the image
        previewImage(mainScreenshotFile, detectionImagePreview);

        // Also copy API key if available
        const openaiApiKeyElem = document.getElementById('openaiApiKey');
        if (openaiApiKeyElem) {
          const mainApiKey = openaiApiKeyElem.value;
          if (mainApiKey && !detectionApiKey.value) {
            detectionApiKey.value = mainApiKey;
          }
        }
      });
    }

    // Preview detection image
    if (detectionImage) {
      detectionImage.addEventListener('change', (e) => {
        previewImage(e.target.files[0], detectionImagePreview);
      });
    }

    // Handle field detection
    if (detectFieldsBtn) {
      detectFieldsBtn.addEventListener('click', async () => {
        if (!detectionImage.files[0]) {
          alert('Please select an image');
          return;
        }

        const apiKey = detectionApiKey.value.trim();
        if (!apiKey) {
          alert('Please enter your OpenAI API key');
          return;
        }

        const formData = new FormData();
        formData.append('image', detectionImage.files[0]);
        formData.append('openaiApiKey', apiKey);

        // Show loading
        detectionLoading.classList.remove('hidden');
        detectionResults.classList.add('hidden');
        detectFieldsBtn.disabled = true;

        try {
          const response = await fetch('/detect-fields', {
            method: 'POST',
            body: formData,
          });

          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Detection failed');
          }

          const result = await response.json();
          displayDetectionResults(result);

          // Automatically compare with Figma fields if available
          if (fetchedFigmaJSON && result.detection) {
            try {
              console.log('Performing field comparison with Figma design...');
              const figmaData = fetchedFigmaJSON;
              
              // Log what we're comparing
              console.log('Figma data structure:', figmaData);
              console.log('Detection result:', result.detection);
              
              // Check if figmaData has the expected structure
              let figmaForComparison = figmaData;
              
              // If figmaData doesn't have properties or formFields at the expected level, restructure it
              if (!figmaData.properties && !figmaData.formFields) {
                console.log('Restructuring Figma data for comparison...');
                // The fetched Figma data might be the raw node data
                // Try to extract properties if they exist
                figmaForComparison = {
                  properties: figmaData.properties || extractDesignProperties(figmaData),
                  formFields: figmaData.formFields || [],
                  raw: figmaData
                };
              }
              
              console.log('Figma data for comparison:', figmaForComparison);
              
              // Perform comparison
              const comparisonResponse = await fetch('/compare-fields', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  source1: figmaForComparison,
                  source2: result.detection,
                  source1Name: 'Figma Design',
                  source2Name: 'Detected Fields',
                }),
              });

              if (comparisonResponse.ok) {
                const comparisonResult = await comparisonResponse.json();
                console.log('Comparison result:', comparisonResult);
                
                if (comparisonResult.success && comparisonResult.comparison) {
                  // Display comparison summary prominently
                  displayFieldComparisonSummary(comparisonResult.comparison);
                  
                  // Also show detailed comparison in a modal or expanded view
                  showDetailedComparison(comparisonResult.comparison);
                } else {
                  console.warn('Comparison succeeded but no comparison data returned');
                }
              } else {
                const error = await comparisonResponse.json();
                console.error('Comparison failed:', error);
                alert('Field comparison failed: ' + (error.error || 'Unknown error'));
              }
            } catch (e) {
              console.error('Auto-comparison error:', e);
              alert('Error comparing fields: ' + e.message);
            }
          } else {
            if (!fetchedFigmaJSON) {
              console.log('No Figma data available for comparison');
              // Show a message to the user
              const noFigmaMsg = document.createElement('div');
              noFigmaMsg.style.cssText = 'margin-top: 20px; padding: 15px; background: #fff3cd; border-radius: 8px; border-left: 4px solid #ffc107;';
              noFigmaMsg.innerHTML = `
                <h4 style="margin-top: 0; color: #856404;">No Figma Design Loaded</h4>
                <p style="margin-bottom: 0; color: #856404;">To compare detected fields with your design, please fetch a Figma design first using the "Fetch Design" button above.</p>
              `;
              const detectionResults = document.getElementById('detectionResults');
              detectionResults.appendChild(noFigmaMsg);
            }
          }
        } catch (error) {
          alert('Detection error: ' + error.message);
        } finally {
          detectionLoading.classList.add('hidden');
          detectFieldsBtn.disabled = false;
        }
      });
    }

    // Display detection results
    function displayDetectionResults(result) {
      detectionResults.classList.remove('hidden');

      const detection = result.detection;

      // Update summary
      const totalDetectedElem = document.getElementById('totalDetected');
      if (totalDetectedElem) {
        totalDetectedElem.textContent =
          detection.detectedElements?.length || '0';
      }
      const detectedScreenTypeElem =
        document.getElementById('detectedScreenType');
      if (detectedScreenTypeElem) {
        detectedScreenTypeElem.textContent =
          detection.summary?.screenType || 'unknown';
      }

      // Display elements
      const elementsList = document.getElementById('elementsList');
      if (!elementsList) return;

      if (
        !detection.detectedElements ||
        detection.detectedElements.length === 0
      ) {
        elementsList.innerHTML =
          '<p style="color: #666;">No elements detected</p>';
      } else {
        const elementsHtml = detection.detectedElements
          .map((elem, index) => {
            const typeClass = elem.type.toLowerCase();
            const bounds = elem.bounds || {};
            const props = elem.properties || {};
            const text = elem.text || {};

            // Get display text
            let displayText =
              text.buttonText ||
              text.label ||
              text.placeholder ||
              text.value ||
              '';
            if (!displayText) {
              displayText = `${elem.type} #${index + 1}`;
            }

            // Build property chips
            const propertyChips = [];
            if (
              props.backgroundColor &&
              props.backgroundColor !== 'transparent'
            ) {
              propertyChips.push(
                `<span class="property-chip" style="background: ${
                  props.backgroundColor
                }; color: ${
                  isLightColor(props.backgroundColor) ? '#000' : '#fff'
                };">BG: ${props.backgroundColor}</span>`
              );
            }
            if (props.borderColor && props.borderColor !== 'none') {
              propertyChips.push(
                `<span class="property-chip">Border: ${props.borderColor}</span>`
              );
            }
            if (props.borderRadius > 0) {
              propertyChips.push(
                `<span class="property-chip">Radius: ${props.borderRadius}px</span>`
              );
            }

            return `
                    <div class="element-item">
                        <span class="element-type ${typeClass}">${
              elem.type
            }</span>
                        <div class="element-details">
                            <div class="element-position">
                                Position: (${bounds.x || 0}, ${
              bounds.y || 0
            }) • Size: ${bounds.width || 0}×${bounds.height || 0}
                            </div>
                            <div class="element-text">${escapeHtml(
                              displayText
                            )}</div>
                            ${
                              propertyChips.length > 0
                                ? `<div class="element-properties">${propertyChips.join(
                                    ''
                                  )}</div>`
                                : ''
                            }
                            ${
                              elem.notes
                                ? `<div style="font-size: 12px; color: #666; margin-top: 5px;">${escapeHtml(
                                    elem.notes
                                  )}</div>`
                                : ''
                            }
                        </div>
                        <div class="element-confidence">
                            <span class="confidence-value">${Math.round(
                              (elem.confidence || 0) * 100
                            )}%</span>
                        </div>
                    </div>
                `;
          })
          .join('');

        elementsList.innerHTML = elementsHtml;
      }

      // Display raw response
      const rawDetectionResponseElem = document.getElementById(
        'rawDetectionResponse'
      );
      if (rawDetectionResponseElem) {
        rawDetectionResponseElem.textContent = JSON.stringify(
          detection,
          null,
          2
        );
      }
    }

    // Helper function to check if color is light
    // Store last detection results for comparison
    let lastOpenAIDetection = null;

    // Show detailed comparison in an expanded view
    function showDetailedComparison(comparison) {
      // Create a detailed comparison section
      const detailDiv = document.createElement('div');
      detailDiv.className = 'detailed-field-comparison';
      detailDiv.style.cssText = 'margin-top: 20px; padding: 20px; background: #f8f9fa; border-radius: 8px; border: 2px solid #dee2e6;';
      
      // Build detailed comparison HTML
      let detailHTML = '<h3 style="margin-top: 0; color: #212529;">Detailed Field Comparison</h3>';
      
      // Show matched fields
      if (comparison.matchedPairs && comparison.matchedPairs.length > 0) {
        detailHTML += '<div style="margin-bottom: 20px;">';
        detailHTML += '<h4 style="color: #28a745;">✓ Matched Fields:</h4>';
        detailHTML += '<div style="display: grid; gap: 10px;">';
        
        comparison.matchedPairs.forEach(pair => {
          const matchQuality = pair.similarity >= 0.9 ? 'excellent' : pair.similarity >= 0.7 ? 'good' : 'fair';
          const qualityColor = matchQuality === 'excellent' ? '#28a745' : matchQuality === 'good' ? '#ffc107' : '#fd7e14';
          
          // Calculate position deviation
          const figmaPos = pair.source1.properties?.position || {};
          const detectedPos = pair.source2.bounds || {};
          const posDeviation = Math.sqrt(
            Math.pow((figmaPos.x || 0) - (detectedPos.x || 0), 2) + 
            Math.pow((figmaPos.y || 0) - (detectedPos.y || 0), 2)
          );
          
          // Calculate size deviation
          const figmaSize = pair.source1.properties?.dimensions || {};
          const detectedSize = pair.source2.bounds || {};
          const widthDiff = Math.abs((figmaSize.width || 0) - (detectedSize.width || 0));
          const heightDiff = Math.abs((figmaSize.height || 0) - (detectedSize.height || 0));
          
          detailHTML += `
            <div style="padding: 15px; background: white; border-radius: 6px; border-left: 4px solid ${qualityColor}; margin-bottom: 10px;">
              <div style="display: flex; justify-content: space-between; align-items: start;">
                <div style="flex: 1;">
                  <div style="margin-bottom: 10px;">
                    <strong>Figma Field:</strong> ${escapeHtml(pair.source1.name || 'Unknown')} (${pair.source1.type})
                    <br>
                    <strong>Detected As:</strong> ${escapeHtml(pair.source2.text?.label || pair.source2.text?.placeholder || pair.source2.type)}
                  </div>
                  
                  <div style="font-size: 12px; color: #6c757d;">
                    <strong>Position Deviation:</strong> ${Math.round(posDeviation)}px
                    ${posDeviation > 10 ? '<span style="color: #dc3545;"> ⚠️ High</span>' : '<span style="color: #28a745;"> ✓ Good</span>'}
                    <br>
                    <strong>Size Difference:</strong> W: ${widthDiff}px, H: ${heightDiff}px
                    ${(widthDiff > 5 || heightDiff > 5) ? '<span style="color: #ffc107;"> ⚠️ Check</span>' : '<span style="color: #28a745;"> ✓ Good</span>'}
                  </div>
                  
                  ${pair.differences && pair.differences.length > 0 ? 
                    `<div style="margin-top: 10px; padding: 10px; background: #f8f9fa; border-radius: 4px;">
                      <strong style="color: #dc3545;">Differences:</strong>
                      <ul style="margin: 5px 0 0 20px; padding: 0;">
                        ${pair.differences.map(diff => 
                          `<li style="color: #6c757d;">${diff.property}: Expected "${diff.expected}" → Found "${diff.actual}"</li>`
                        ).join('')}
                      </ul>
                    </div>` : ''}
                </div>
                <div style="text-align: right; min-width: 120px;">
                  <span style="color: ${qualityColor}; font-weight: bold; font-size: 18px;">${Math.round(pair.similarity * 100)}%</span>
                  <br>
                  <small style="color: #6c757d;">${matchQuality} match</small>
                </div>
              </div>
            </div>
          `;
        });
        
        detailHTML += '</div></div>';
      }
      
      // Show unmatched Figma fields
      if (comparison.unmatchedSource1 && comparison.unmatchedSource1.length > 0) {
        detailHTML += '<div style="margin-bottom: 20px;">';
        detailHTML += '<h4 style="color: #dc3545;">✗ Missing from Implementation:</h4>';
        detailHTML += '<div style="display: grid; gap: 10px;">';
        
        comparison.unmatchedSource1.forEach(field => {
          detailHTML += `
            <div style="padding: 10px; background: #f8d7da; border-radius: 6px; border-left: 4px solid #dc3545;">
              <strong>${escapeHtml(field.name || 'Unknown')}</strong> (${field.type})
              ${field.label ? `<br><small>Label: ${escapeHtml(field.label)}</small>` : ''}
              <br><small style="color: #721c24;">Expected at position (${field.properties?.position?.x || 0}, ${field.properties?.position?.y || 0})</small>
            </div>
          `;
        });
        
        detailHTML += '</div></div>';
      }
      
      // Show unexpected detected fields
      if (comparison.unmatchedSource2 && comparison.unmatchedSource2.length > 0) {
        detailHTML += '<div style="margin-bottom: 20px;">';
        detailHTML += '<h4 style="color: #856404;">⚠ Extra Fields Detected:</h4>';
        detailHTML += '<div style="display: grid; gap: 10px;">';
        
        comparison.unmatchedSource2.forEach(field => {
          detailHTML += `
            <div style="padding: 10px; background: #fff3cd; border-radius: 6px; border-left: 4px solid #ffc107;">
              <strong>${field.type}</strong>
              ${field.text?.label || field.text?.placeholder || field.text?.buttonText ? 
                `<br>Text: "${escapeHtml(field.text.label || field.text.placeholder || field.text.buttonText)}"` : ''}
              <br><small style="color: #856404;">Found at (${field.bounds?.x || 0}, ${field.bounds?.y || 0})</small>
            </div>
          `;
        });
        
        detailHTML += '</div></div>';
      }
      
      detailDiv.innerHTML = detailHTML;
      
      // Insert after the summary
      const detectionResults = document.getElementById('detectionResults');
      const existingDetail = detectionResults.querySelector('.detailed-field-comparison');
      if (existingDetail) {
        existingDetail.remove();
      }
      
      // Find the summary div and insert detail after it
      const summaryDiv = detectionResults.querySelector('.field-comparison-summary');
      if (summaryDiv && summaryDiv.nextSibling) {
        detectionResults.insertBefore(detailDiv, summaryDiv.nextSibling);
      } else {
        detectionResults.appendChild(detailDiv);
      }
    }

    // Display field comparison summary in detection results
    function displayFieldComparisonSummary(comparison) {
      console.log('Field comparison summary data:', comparison);
      
      // Add comparison summary to detection results
      const summaryDiv = document.createElement('div');
      summaryDiv.className = 'field-comparison-summary';
      summaryDiv.style.cssText =
        'margin-top: 20px; padding: 15px; background: #e8f4f8; border-radius: 8px; border-left: 4px solid #3498db;';

      // Extract data with fallbacks
      const overallAccuracy = comparison.accuracyMetrics?.overallAccuracy || 0;
      const positionAccuracy = comparison.accuracyMetrics?.positionAccuracy || 0;
      const typeAccuracy = comparison.accuracyMetrics?.typeAccuracy || 0;
      const dimensionAccuracy = comparison.accuracyMetrics?.dimensionAccuracy || 0;
      
      // Get match counts
      const matchedCount = comparison.matchedPairs?.length || 
                          comparison.summary?.matches?.total || 0;
      const totalExpected = comparison.summary?.source1?.totalFields || 
                           comparison.source1Fields?.length || 0;
      const unmatchedFigma = comparison.unmatchedSource1?.length || 0;
      const unmatchedDetected = comparison.unmatchedSource2?.length || 0;
      
      // Calculate overall accuracy if not provided
      let calculatedAccuracy = overallAccuracy;
      if (calculatedAccuracy === 0 && totalExpected > 0) {
        calculatedAccuracy = matchedCount / totalExpected;
      }

      summaryDiv.innerHTML = `
            <h4 style="margin-top: 0; color: #2c3e50;">Field Comparison with Figma Design</h4>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 10px;">
                <div>
                    <strong>Overall Accuracy:</strong> 
                    <span style="color: ${
                      calculatedAccuracy >= 0.8
                        ? '#27ae60'
                        : calculatedAccuracy >= 0.6
                        ? '#f39c12'
                        : '#e74c3c'
                    }">
                        ${Math.round(calculatedAccuracy * 100)}%
                    </span>
                </div>
                <div>
                    <strong>Matched Fields:</strong> ${matchedCount} / ${totalExpected}
                    ${unmatchedDetected > 0 ? `<small>(+${unmatchedDetected} extra)</small>` : ''}
                </div>
                <div>
                    <strong>Position Accuracy:</strong> ${Math.round(positionAccuracy * 100)}%
                </div>
                <div>
                    <strong>Type Accuracy:</strong> ${Math.round(typeAccuracy * 100)}%
                </div>
            </div>
            ${totalExpected === 0 ? 
              '<p style="margin-top: 10px; color: #ffc107;">⚠️ No form fields found in Figma design to compare</p>' :
              unmatchedFigma > 0 ? 
                `<p style="margin-top: 10px; color: #e74c3c;">⚠️ Missing ${unmatchedFigma} expected field(s) from design</p>` :
                '<p style="margin-top: 10px; color: #27ae60;">✓ All expected fields detected!</p>'
            }
        `;

      // Insert after the detected elements list
      const detectionResults = document.getElementById('detectionResults');
      const elementsDiv = detectionResults.querySelector('.detected-elements');
      if (elementsDiv && elementsDiv.nextSibling) {
        detectionResults.insertBefore(summaryDiv, elementsDiv.nextSibling);
      } else {
        detectionResults.appendChild(summaryDiv);
      }
    }

    // Update storage when detection completes
    const originalDisplayDetectionResults = displayDetectionResults;
    displayDetectionResults = function (result) {
      originalDisplayDetectionResults(result);
      lastOpenAIDetection = result.detection;
    };
  }
  
  // Element Comparison functionality
  const elementCompareBtn = document.getElementById('elementCompareBtn');
  if (elementCompareBtn) {
    elementCompareBtn.addEventListener('click', async () => {
      if (!fetchedFigmaJSON) {
        alert('Please fetch a Figma design first using the Fetch Design button');
        return;
      }
      
      const screenshotInput = document.getElementById('codeScreenshot');
      if (!screenshotInput.files[0]) {
        alert('Please select a code output screenshot');
        return;
      }
      
      const formData = new FormData();
      formData.append('figmaJSON', JSON.stringify(fetchedFigmaJSON));
      formData.append('screenshot', screenshotInput.files[0]);
      
      // Show loading
      const loading = document.getElementById('loading');
      const results = document.getElementById('results');
      if (loading) {
        loading.classList.remove('hidden');
        results.classList.add('hidden');
        const loadingMessage = loading.querySelector('p');
        if (loadingMessage) {
          loadingMessage.textContent = 'Performing OCR and element comparison...';
        }
      }
      
      try {
        const response = await fetch('/api/compare-elements', {
          method: 'POST',
          body: formData,
        });
        
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Element comparison failed');
        }
        
        const elementReport = await response.json();
        displayElementComparison(elementReport);
        
        // Show results and switch to element comparison tab
        if (loading) loading.classList.add('hidden');
        if (results) results.classList.remove('hidden');
        
        const resultTabs = document.getElementById('resultTabs');
        if (resultTabs) resultTabs.classList.remove('hidden');
        
        showResultTab('element-comparison');
        
      } catch (error) {
        alert('Error: ' + error.message);
      } finally {
        if (loading) loading.classList.add('hidden');
      }
    });
  }
});

// Display element comparison results
function displayElementComparison(report) {
  if (!report || !report.summary) return;
  
  // Update summary cards
  setTextContent('totalElementsCount', report.summary.totalElements || 0);
  setTextContent('matchedElementsCount', report.summary.matchedElements || 0);
  setTextContent('matchingCount', report.summary.matchingElements || 0);
  setTextContent('notMatchingCount', report.summary.notMatchingElements || 0);
  setTextContent('elementAccuracy', report.summary.overallAccuracy || '0%');
  
  // Populate comparison table
  const tbody = document.getElementById('elementComparisonBody');
  if (tbody && report.comparisonTable) {
    tbody.innerHTML = '';
    
    report.comparisonTable.forEach(item => {
      const row = document.createElement('tr');
      row.className = item.overallMatch === 'MATCHING' ? 'matching-row' : 'not-matching-row';
      row.dataset.issues = item.issues ? item.issues.join(',') : '';
      
      // Helper to create color cell
      const createColorCell = (color) => {
        if (!color || color === 'transparent' || color === 'Not specified') {
          return `<td>${color || 'N/A'}</td>`;
        }
        return `<td><span class="color-chip" style="background: ${color}"></span> ${color}</td>`;
      };
      
      // Helper to create match status cell
      const createStatusCell = (status) => {
        let icon = '';
        let className = '';
        if (status === 'MATCHING') {
          icon = '✅';
          className = 'status-matching';
        } else if (status === 'NOT MATCHING') {
          icon = '❌';
          className = 'status-not-matching';
        } else {
          icon = '⚠️';
          className = 'status-unknown';
        }
        return `<td class="${className}">${icon} ${status}</td>`;
      };
      
      row.innerHTML = `
        <td>${escapeHtml(item.element)}</td>
        <td><span class="match-type-badge ${item.matchType?.toLowerCase()}">${item.matchType || 'N/A'}</span></td>
        ${createColorCell(item.figmaProperties.textColor)}
        ${createColorCell(item.screenshotProperties.textColor)}
        ${createStatusCell(item.comparison.textColor)}
        ${createColorCell(item.figmaProperties.backgroundColor)}
        ${createColorCell(item.screenshotProperties.backgroundColor)}
        ${createStatusCell(item.comparison.backgroundColor)}
        <td>${item.figmaProperties.fontSize || 'N/A'}px / ${item.screenshotProperties.fontSize || 'N/A'}px</td>
        ${createStatusCell(item.overallMatch)}
        <td>${item.issues ? item.issues.join(', ') : 'None'}</td>
      `;
      
      tbody.appendChild(row);
    });
  }
  
  // Display unmatched elements
  const unmatchedFigmaList = document.getElementById('unmatchedFigmaList');
  if (unmatchedFigmaList && report.unmatchedFigmaElements) {
    unmatchedFigmaList.innerHTML = '';
    if (report.unmatchedFigmaElements.length > 0) {
      report.unmatchedFigmaElements.forEach(el => {
        const div = document.createElement('div');
        div.className = 'unmatched-item';
        div.innerHTML = `
          <strong>${escapeHtml(el.text)}</strong>
          <span class="unmatched-details">Color: ${el.color || 'N/A'}, Size: ${el.fontSize || 'N/A'}px</span>
          <span class="unmatched-reason">${el.reason}</span>
        `;
        unmatchedFigmaList.appendChild(div);
      });
    } else {
      unmatchedFigmaList.innerHTML = '<p class="no-items">All Figma elements matched!</p>';
    }
  }
  
  const unmatchedScreenshotList = document.getElementById('unmatchedScreenshotList');
  if (unmatchedScreenshotList && report.unmatchedScreenshotElements) {
    unmatchedScreenshotList.innerHTML = '';
    if (report.unmatchedScreenshotElements.length > 0) {
      report.unmatchedScreenshotElements.forEach(el => {
        const div = document.createElement('div');
        div.className = 'unmatched-item';
        div.innerHTML = `
          <strong>${escapeHtml(el.text)}</strong>
          <span class="unmatched-reason">${el.reason}</span>
        `;
        unmatchedScreenshotList.appendChild(div);
      });
    } else {
      unmatchedScreenshotList.innerHTML = '<p class="no-items">All screenshot elements matched!</p>';
    }
  }
}

// Filter elements in the comparison table
function filterElements(filterType) {
  const tbody = document.getElementById('elementComparisonBody');
  if (!tbody) return;
  
  const rows = tbody.querySelectorAll('tr');
  const filterBtns = document.querySelectorAll('.filter-btn');
  
  // Update active button
  filterBtns.forEach(btn => {
    btn.classList.remove('active');
    if (btn.getAttribute('onclick').includes(`'${filterType}'`)) {
      btn.classList.add('active');
    }
  });
  
  // Apply filter
  rows.forEach(row => {
    switch(filterType) {
      case 'all':
        row.style.display = '';
        break;
      case 'matching':
        row.style.display = row.classList.contains('matching-row') ? '' : 'none';
        break;
      case 'not-matching':
        row.style.display = row.classList.contains('not-matching-row') ? '' : 'none';
        break;
      case 'color-issues':
        const hasColorIssue = row.dataset.issues && 
          (row.dataset.issues.includes('TEXT_COLOR') || row.dataset.issues.includes('BACKGROUND_COLOR'));
        row.style.display = hasColorIssue ? '' : 'none';
        break;
      case 'font-issues':
        const hasFontIssue = row.dataset.issues && row.dataset.issues.includes('FONT_SIZE');
        row.style.display = hasFontIssue ? '' : 'none';
        break;
    }
  });
}
