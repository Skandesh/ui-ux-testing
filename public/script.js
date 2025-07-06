// Helper function to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('compareForm');
    const figmaJSONInput = document.getElementById('figmaJSON');
    const screenshotInput = document.getElementById('codeScreenshot');
    const jsonPreview = document.getElementById('jsonPreview');
    const screenshotPreview = document.getElementById('screenshotPreview');
    const loading = document.getElementById('loading');
    const results = document.getElementById('results');
    const downloadBtn = document.getElementById('downloadReport');
    
    // Figma input elements
    const figmaLinkInput = document.getElementById('figmaLink');
    const figmaTokenInput = document.getElementById('figmaToken');
    const fetchFigmaBtn = document.getElementById('fetchFigmaBtn');
    
    let currentReport = null;
    let parsedJSON = null;
    
    // Result tab functionality
    window.showResultTab = function(tabName) {
        const overviewTab = document.getElementById('overview-tab');
        const detailedTab = document.getElementById('detailed-tab');
        const aiAnalysisTab = document.getElementById('ai-analysis-tab');
        const tabButtons = document.querySelectorAll('.tab-button');
        
        // Remove active class from all tabs and buttons
        [overviewTab, detailedTab, aiAnalysisTab].forEach(tab => {
            if (tab) tab.classList.remove('active');
        });
        tabButtons.forEach(btn => btn.classList.remove('active'));
        
        // Show the selected tab
        if (tabName === 'overview') {
            overviewTab.classList.add('active');
            tabButtons[0].classList.add('active');
        } else if (tabName === 'detailed') {
            detailedTab.classList.add('active');
            tabButtons[1].classList.add('active');
        } else if (tabName === 'ai-analysis') {
            aiAnalysisTab.classList.add('active');
            tabButtons[2].classList.add('active');
        }
    };
    
    // Preview JSON input
    figmaJSONInput.addEventListener('input', (e) => {
        try {
            parsedJSON = JSON.parse(e.target.value);
            displayJSONPreview(parsedJSON);
        } catch (error) {
            jsonPreview.innerHTML = '<span style="color: #e74c3c;">Invalid JSON</span>';
        }
    });
    
    // Preview uploaded screenshot
    screenshotInput.addEventListener('change', (e) => {
        previewImage(e.target.files[0], screenshotPreview);
    });
    
    // Fetch Figma design
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
            showStatus('Invalid Figma URL. Please use a valid Figma file or design link.', 'error');
            return;
        }
        
        fetchFigmaBtn.disabled = true;
        fetchFigmaBtn.textContent = 'Fetching...';
        showStatus('Connecting to Figma API...', 'info');
        
        try {
            const design = await fetchFigmaDesign(figmaData.fileKey, figmaData.nodeId, figmaToken);
            if (design) {
                figmaJSONInput.value = JSON.stringify(design, null, 2);
                parsedJSON = design;
                displayJSONPreview(design);
                
                const nodeInfo = figmaData.nodeId ? ` (Node: ${figmaData.nodeId})` : '';
                showStatus(`Successfully fetched design${nodeInfo}`, 'success');
            }
        } catch (error) {
            showStatus('Error: ' + error.message, 'error');
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
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        if (!parsedJSON) {
            alert('Please enter valid Figma JSON');
            return;
        }
        
        const openaiApiKey = document.getElementById('openaiApiKey').value.trim();
        const useAI = openaiApiKey.length > 0;
        
        const formData = new FormData();
        formData.append('figmaJSON', JSON.stringify(parsedJSON));
        formData.append('screenshot', screenshotInput.files[0]);
        
        if (useAI) {
            formData.append('openaiApiKey', openaiApiKey);
        }
        
        // Show loading with appropriate message
        loading.classList.remove('hidden');
        results.classList.add('hidden');
        const loadingMessage = loading.querySelector('p');
        loadingMessage.textContent = useAI ? 
            'Analyzing with AI enhancement...' : 
            'Analyzing pixel differences...';
        
        try {
            const endpoint = useAI ? '/analyze-with-ai' : '/analyze';
            const response = await fetch(endpoint, {
                method: 'POST',
                body: formData
            });
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Analysis failed');
            }
            
            const report = await response.json();
            currentReport = report;
            displayResults(report);
            
            // Show tabs after results are loaded
            document.getElementById('resultTabs').classList.remove('hidden');
            
            // If AI analysis was successful, show AI tab by default
            if (useAI && report.analysisType === 'AI_ENHANCED') {
                showResultTab('ai-analysis');
            }
            
        } catch (error) {
            alert('Error: ' + error.message);
            // Reset loading message
            loadingMessage.textContent = 'Analyzing pixel differences...';
        } finally {
            loading.classList.add('hidden');
        }
    });
    
    function displayResults(report) {
        const accuracy = parseFloat(report.accuracy || 0);
        
        // Update score circle
        const scoreCircle = document.getElementById('scoreCircle');
        const scoreDescription = document.getElementById('scoreDescription');
        
        document.getElementById('similarity').textContent = accuracy + '%';
        
        // Style score circle based on accuracy
        scoreCircle.classList.remove('score-excellent', 'score-good', 'score-poor');
        
        if (accuracy >= 95) {
            scoreCircle.classList.add('score-excellent');
            scoreDescription.textContent = 'Excellent! Implementation matches specifications.';
        } else if (accuracy >= 80) {
            scoreCircle.classList.add('score-good');
            scoreDescription.textContent = 'Good implementation with minor differences.';
        } else {
            scoreCircle.classList.add('score-poor');
            scoreDescription.textContent = 'Multiple specification mismatches found.';
        }
        
        // Update stats
        document.getElementById('diffRegions').textContent = report.totalMismatches || '0';
        // Fix: Display count instead of array
        const colorMismatchCount = Array.isArray(report.colorMismatches) ? report.colorMismatches.length : report.colorMismatches || '0';
        document.getElementById('diffPixels').textContent = colorMismatchCount;
        
        // Display specifications vs detected properties
        displaySpecComparison(report);
        
        // Display spacing visualization if available
        if (report.visualizations && report.visualizations.spacingOverlay) {
            const spacingImg = document.getElementById('spacingOverlay');
            const placeholder = document.getElementById('spacingOverlayPlaceholder');
            
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
    }
    
    // Display AI analysis results
    function displayAIAnalysis(report) {
        const confidenceCircle = document.getElementById('aiConfidenceCircle');
        const confidenceDescription = document.getElementById('aiConfidenceDescription');
        const aiConfidenceEl = document.getElementById('aiConfidence');
        const confidenceLabel = document.querySelector('#aiConfidenceCircle .confidence-label');
        
        // Check if we have comparison results from AI
        if (report.aiAnalysis && report.aiAnalysis.comparisonResults) {
            const comparisonResults = report.aiAnalysis.comparisonResults;
            const overallMatch = comparisonResults.overallMatch || 0;
            
            // Show overall match percentage instead of confidence
            aiConfidenceEl.textContent = overallMatch + '%';
            
            // Update the label to show "match" instead of "confidence"
            if (confidenceLabel) {
                confidenceLabel.textContent = 'match';
            }
            
            // Update the heading
            const aiConfidenceHeading = document.querySelector('.ai-confidence h3');
            if (aiConfidenceHeading) {
                aiConfidenceHeading.textContent = 'Design Match Score';
            }
            
            // Style circle based on match percentage
            confidenceCircle.classList.remove('confidence-high', 'confidence-medium', 'confidence-low');
            
            if (overallMatch >= 90) {
                confidenceCircle.classList.add('confidence-high');
                confidenceDescription.textContent = comparisonResults.summary || 'Excellent match with Figma design specifications.';
            } else if (overallMatch >= 70) {
                confidenceCircle.classList.add('confidence-medium');
                confidenceDescription.textContent = comparisonResults.summary || 'Good match with some deviations from design.';
            } else {
                confidenceCircle.classList.add('confidence-low');
                confidenceDescription.textContent = comparisonResults.summary || 'Significant deviations from Figma design detected.';
            }
        } else {
            // Fallback to confidence score
            const aiConfidence = Math.round((report.confidenceScore || 0.5) * 100);
            aiConfidenceEl.textContent = aiConfidence + '%';
            
            // Keep original label
            if (confidenceLabel) {
                confidenceLabel.textContent = 'confidence';
            }
            
            // Style confidence circle based on score
            confidenceCircle.classList.remove('confidence-high', 'confidence-medium', 'confidence-low');
            
            if (aiConfidence >= 80) {
                confidenceCircle.classList.add('confidence-high');
                confidenceDescription.textContent = 'High confidence AI analysis - GPT-4 Vision provided detailed insights.';
            } else if (aiConfidence >= 60) {
                confidenceCircle.classList.add('confidence-medium');
                confidenceDescription.textContent = 'Medium confidence AI analysis - Some insights may be limited.';
            } else {
                confidenceCircle.classList.add('confidence-low');
                confidenceDescription.textContent = 'Low confidence AI analysis - Review insights carefully.';
            }
        }
        
        // Update comparison stats
        document.getElementById('cvElementCount').textContent = 
            report.detectedProperties?.enhancedAnalysis?.totalElementsCV || '0';
        document.getElementById('aiElementCount').textContent = 
            report.detectedProperties?.enhancedAnalysis?.totalElementsAI || '0';
        document.getElementById('cvLayoutComplexity').textContent = 
            report.detectedProperties?.enhancedAnalysis?.layoutComplexityCV || 'unknown';
        document.getElementById('aiLayoutType').textContent = 
            report.detectedProperties?.enhancedAnalysis?.layoutComplexityAI || 'unknown';
        
        // Display AI insights
        const insightsList = document.getElementById('aiInsightsList');
        if (report.insights && report.insights.length > 0) {
            const insights = report.insights.map(insight => `<li>${insight}</li>`).join('');
            insightsList.innerHTML = `<ul>${insights}</ul>`;
        } else {
            insightsList.innerHTML = '<p>No specific AI insights generated.</p>';
        }
        
        // Display recommendations
        const recommendationsList = document.getElementById('aiRecommendationsList');
        if (report.recommendations && report.recommendations.length > 0) {
            const recommendations = report.recommendations.map(rec => `<li>${rec}</li>`).join('');
            recommendationsList.innerHTML = `<ul>${recommendations}</ul>`;
        } else {
            recommendationsList.innerHTML = '<p>No specific AI recommendations generated.</p>';
        }
        
        // Display detailed AI analysis sections
        displayAIDetailedSections(report);
        
        // Display raw AI response
        const rawResponse = document.getElementById('aiRawResponse');
        if (report.aiAnalysis && report.aiAnalysis.rawResponse) {
            rawResponse.innerHTML = `<pre>${escapeHtml(report.aiAnalysis.rawResponse)}</pre>`;
        } else if (report.aiAnalysis && report.aiAnalysis.rawAnalysis) {
            // Fallback for when parsing failed
            rawResponse.innerHTML = `<pre>${escapeHtml(report.aiAnalysis.rawAnalysis)}</pre>`;
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
            if (aiAnalysis.colorComparison.figmaColors && aiAnalysis.colorComparison.detectedColors) {
                colorContent += `<p><strong>Expected Colors (Figma):</strong> ${aiAnalysis.colorComparison.figmaColors.join(', ')}</p>`;
                colorContent += `<p><strong>Detected Colors:</strong> ${aiAnalysis.colorComparison.detectedColors.join(', ')}</p>`;
            }
            
            // Show color deviations
            if (aiAnalysis.colorComparison.deviations && aiAnalysis.colorComparison.deviations.length > 0) {
                colorContent += `<p class="deviation-header"><strong>⚠️ Color Deviations:</strong></p>`;
                colorContent += '<ul class="deviation-list">';
                aiAnalysis.colorComparison.deviations.forEach(deviation => {
                    colorContent += `<li class="deviation-item">${deviation}</li>`;
                });
                colorContent += '</ul>';
            }
            
            // Show missing colors
            if (aiAnalysis.colorComparison.missingColors && aiAnalysis.colorComparison.missingColors.length > 0) {
                colorContent += `<p><strong>Missing Colors:</strong> ${aiAnalysis.colorComparison.missingColors.join(', ')}</p>`;
            }
            
            // Show extra colors
            if (aiAnalysis.colorComparison.extraColors && aiAnalysis.colorComparison.extraColors.length > 0) {
                colorContent += `<p><strong>Extra Colors (not in design):</strong> ${aiAnalysis.colorComparison.extraColors.join(', ')}</p>`;
            }
            
            colorAnalysis.innerHTML = colorContent;
        } else if (aiAnalysis.colors) {
            // Fallback to old format
            let colorContent = '';
            if (aiAnalysis.colors.primary && aiAnalysis.colors.primary.length > 0) {
                colorContent += `<p><strong>Primary Colors:</strong> ${aiAnalysis.colors.primary.join(', ')}</p>`;
            }
            if (aiAnalysis.colors.secondary && aiAnalysis.colors.secondary.length > 0) {
                colorContent += `<p><strong>Secondary Colors:</strong> ${aiAnalysis.colors.secondary.join(', ')}</p>`;
            }
            if (aiAnalysis.colors.issues && aiAnalysis.colors.issues.length > 0) {
                colorContent += `<p><strong>Issues:</strong></p><ul>${aiAnalysis.colors.issues.map(issue => `<li>${issue}</li>`).join('')}</ul>`;
            }
            colorAnalysis.innerHTML = colorContent || '<p>No specific color insights from AI analysis.</p>';
        } else {
            colorAnalysis.innerHTML = '<p>No color analysis available from AI.</p>';
        }
        
        // Spacing analysis - now showing comparison results
        const spacingAnalysis = document.getElementById('aiSpacingAnalysis');
        if (aiAnalysis.spacingComparison) {
            let spacingContent = '<h5>Spacing Comparison Results:</h5>';
            
            // Show expected vs detected spacing
            if (aiAnalysis.spacingComparison.figmaSpacing && aiAnalysis.spacingComparison.detectedSpacing) {
                const figmaSpacing = aiAnalysis.spacingComparison.figmaSpacing;
                const detectedSpacing = aiAnalysis.spacingComparison.detectedSpacing;
                
                spacingContent += '<div class="spacing-comparison-grid">';
                spacingContent += '<div><strong>Expected (Figma):</strong>';
                if (figmaSpacing.padding) {
                    spacingContent += `<br>Padding: ${JSON.stringify(figmaSpacing.padding)}`;
                }
                if (figmaSpacing.gap) {
                    spacingContent += `<br>Gap: ${figmaSpacing.gap}px`;
                }
                spacingContent += '</div>';
                
                spacingContent += '<div><strong>Detected:</strong>';
                if (detectedSpacing.padding) {
                    spacingContent += `<br>Padding: ${JSON.stringify(detectedSpacing.padding)}`;
                }
                if (detectedSpacing.gaps && detectedSpacing.gaps.length > 0) {
                    spacingContent += `<br>Gaps: ${detectedSpacing.gaps.join('px, ')}px`;
                }
                spacingContent += '</div></div>';
            }
            
            // Show spacing deviations
            if (aiAnalysis.spacingComparison.deviations && aiAnalysis.spacingComparison.deviations.length > 0) {
                spacingContent += `<p class="deviation-header"><strong>⚠️ Spacing Deviations:</strong></p>`;
                spacingContent += '<ul class="deviation-list">';
                aiAnalysis.spacingComparison.deviations.forEach(deviation => {
                    spacingContent += `<li class="deviation-item">${deviation}</li>`;
                });
                spacingContent += '</ul>';
            }
            
            spacingAnalysis.innerHTML = spacingContent;
        } else if (aiAnalysis.spacing) {
            // Fallback to old format
            let spacingContent = '';
            if (aiAnalysis.spacing.patterns && aiAnalysis.spacing.patterns.length > 0) {
                spacingContent += `<p><strong>Patterns:</strong> ${aiAnalysis.spacing.patterns.join(', ')}</p>`;
            }
            if (aiAnalysis.spacing.gaps && aiAnalysis.spacing.gaps.length > 0) {
                spacingContent += `<p><strong>Common Gaps:</strong> ${aiAnalysis.spacing.gaps.join('px, ')}px</p>`;
            }
            if (aiAnalysis.spacing.issues && aiAnalysis.spacing.issues.length > 0) {
                spacingContent += `<p><strong>Issues:</strong></p><ul>${aiAnalysis.spacing.issues.map(issue => `<li>${issue}</li>`).join('')}</ul>`;
            }
            spacingAnalysis.innerHTML = spacingContent || '<p>No specific spacing insights from AI analysis.</p>';
        } else {
            spacingAnalysis.innerHTML = '<p>No spacing analysis available from AI.</p>';
        }
        
        // Typography analysis
        const typographyAnalysis = document.getElementById('aiTypographyAnalysis');
        if (aiAnalysis.typography) {
            let typographyContent = '';
            if (aiAnalysis.typography.fonts && aiAnalysis.typography.fonts.length > 0) {
                typographyContent += `<p><strong>Detected Fonts:</strong> ${aiAnalysis.typography.fonts.join(', ')}</p>`;
            }
            if (aiAnalysis.typography.sizes && aiAnalysis.typography.sizes.length > 0) {
                typographyContent += `<p><strong>Font Sizes:</strong> ${aiAnalysis.typography.sizes.join('px, ')}px</p>`;
            }
            if (aiAnalysis.typography.hierarchy) {
                typographyContent += `<p><strong>Typography Hierarchy:</strong> ${aiAnalysis.typography.hierarchy}</p>`;
            }
            if (aiAnalysis.typography.issues && aiAnalysis.typography.issues.length > 0) {
                typographyContent += `<p><strong>Issues:</strong></p><ul>${aiAnalysis.typography.issues.map(issue => `<li>${issue}</li>`).join('')}</ul>`;
            }
            typographyAnalysis.innerHTML = typographyContent || '<p>No specific typography insights from AI analysis.</p>';
        } else {
            typographyAnalysis.innerHTML = '<p>No typography analysis available from AI.</p>';
        }
        
        // Accessibility analysis
        const accessibilityAnalysis = document.getElementById('aiAccessibilityAnalysis');
        if (aiAnalysis.accessibility) {
            let accessibilityContent = '';
            if (aiAnalysis.accessibility.contrast) {
                accessibilityContent += `<p><strong>Color Contrast:</strong> ${aiAnalysis.accessibility.contrast}</p>`;
            }
            if (aiAnalysis.accessibility.issues && aiAnalysis.accessibility.issues.length > 0) {
                accessibilityContent += `<p><strong>Accessibility Issues:</strong></p><ul>${aiAnalysis.accessibility.issues.map(issue => `<li>${issue}</li>`).join('')}</ul>`;
            }
            accessibilityAnalysis.innerHTML = accessibilityContent || '<p>No specific accessibility insights from AI analysis.</p>';
        } else {
            accessibilityAnalysis.innerHTML = '<p>No accessibility analysis available from AI.</p>';
        }
    }
    
    // Download report
    downloadBtn.addEventListener('click', () => {
        if (currentReport) {
            generateHTMLReport(currentReport);
        }
    });
    
    function generateHTMLReport(report) {
        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>UI/UX Comparison Report - ${new Date(report.timestamp).toLocaleString()}</title>
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
        <p class="timestamp">Generated on: ${new Date(report.timestamp).toLocaleString()}</p>
    </div>
    
    <div class="summary">
        <h2>Summary</h2>
        <div class="metrics">
            <div class="metric">
                <span class="metric-label">Overall Similarity</span>
                <span class="metric-value ${
                    parseFloat(report.similarity) >= 95 ? 'similarity-high' : 
                    parseFloat(report.similarity) >= 80 ? 'similarity-medium' : 
                    'similarity-low'
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
                <img src="${window.location.origin}${report.figmaImage}" alt="Figma Design">
            </div>
            <div class="image-item">
                <h3>Rendered Screen</h3>
                <img src="${window.location.origin}${report.renderedImage}" alt="Rendered Screen">
            </div>
            <div class="image-item" style="grid-column: 1 / -1;">
                <h3>UI Differences Visualization</h3>
                <img src="${window.location.origin}${report.overlayImage || report.diffImage}" alt="UI Differences Visualization" style="max-width: 800px; margin: 0 auto; display: block; border: 2px solid #e74c3c;">
                <p style="font-size: 14px; color: #7f8c8d; margin-top: 10px;">
                    Red boxes highlight UI regions with differences • ${report.diffRegions || 0} regions detected
                </p>
            </div>
        </div>
    </div>
    
    <div class="analysis">
        <h2>Analysis & Recommendations</h2>
        ${generateAnalysis(report)}
    </div>
    
    <div class="footer">
        <p>Report ID: ${report.id} | Dimensions: ${report.dimensions.width}x${report.dimensions.height}px</p>
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
                <strong>UI Analysis:</strong> Found ${report.diffRegions || 0} UI regions with differences affecting ${report.diffPixels.toLocaleString()} pixels total.
            </div>
        `;
        
        if (report.diffPixels > 0) {
            analysis += `
                <div class="analysis-item">
                    <strong>Recommendations:</strong>
                    <ul style="margin: 10px 0 0 20px;">
                        ${report.diffRegions > 5 ? '<li>Multiple UI components need attention - prioritize the largest difference regions</li>' : ''}
                        ${report.diffRegions > 0 ? '<li>Check the highlighted regions for missing elements, wrong colors, or layout shifts</li>' : ''}
                        ${similarity < 90 ? '<li>Verify component spacing and alignment matches the design grid</li>' : ''}
                        ${similarity < 85 ? '<li>Review text styling (font family, size, weight, color) in affected regions</li>' : ''}
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
        const preview = document.getElementById('jsonPreview');
        const properties = extractDesignProperties(json);
        
        console.log('Extracted properties:', properties);
        
        let html = '<div class="json-properties">';
        if (properties.colors && properties.colors.length > 0) {
            html += '<strong>Colors:</strong> ';
            html += properties.colors.slice(0, 3).map(c => {
                const colorValue = typeof c === 'string' ? c : c.value || c.hex || '#000000';
                return `<span style="background: ${colorValue}; padding: 2px 8px; margin: 2px; border-radius: 3px; color: ${isLightColor(colorValue) ? '#000' : '#fff'};">${colorValue}</span>`;
            }).join('');
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
                html += `<strong>Font:</strong> ${properties.typography.fontFamily || 'Not specified'}<br>`;
                html += `<strong>Size:</strong> ${properties.typography.fontSize || 'Not specified'}<br>`;
            }
        }
        html += '</div>';
        
        preview.innerHTML = html;
    }
    
    // Extract design properties from Figma JSON
    function extractDesignProperties(json) {
        const properties = {
            colors: [],
            typography: {},
            spacing: {},
            dimensions: {}
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
                node.fills.forEach(fill => {
                    if (fill.visible !== false && fill.color) {
                        const hex = rgbToHex(fill.color);
                        if (!properties.colors.includes(hex)) {
                            properties.colors.push(hex);
                        }
                    } else if (fill.visible !== false && fill.type === 'SOLID' && fill.opacity !== 0) {
                        // Sometimes color is directly in the fill object
                        if (fill.r !== undefined && fill.g !== undefined && fill.b !== undefined) {
                            const hex = rgbToHex({ r: fill.r, g: fill.g, b: fill.b });
                            if (!properties.colors.includes(hex)) {
                                properties.colors.push(hex);
                            }
                        }
                    }
                });
            }
            
            if (node.strokes && Array.isArray(node.strokes)) {
                node.strokes.forEach(stroke => {
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
                        lineHeight: node.style.lineHeightPx || node.style.lineHeightPercent,
                        letterSpacing: node.style.letterSpacing,
                        textAlign: node.style.textAlignHorizontal
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
                    height: Math.round(node.absoluteBoundingBox.height)
                };
            }
            
            // Extract padding
            if (node.paddingLeft !== undefined) {
                properties.spacing = {
                    paddingTop: node.paddingTop || 0,
                    paddingRight: node.paddingRight || 0,
                    paddingBottom: node.paddingBottom || 0,
                    paddingLeft: node.paddingLeft || 0
                };
            }
            
            // Traverse children
            if (node.children && Array.isArray(node.children)) {
                node.children.forEach(child => traverseNode(child));
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
        return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    }
    
    // Check if color is light or dark
    function isLightColor(hex) {
        const color = hex.substring(1); // Remove #
        const r = parseInt(color.substr(0, 2), 16);
        const g = parseInt(color.substr(2, 2), 16);
        const b = parseInt(color.substr(4, 2), 16);
        const brightness = ((r * 299) + (g * 587) + (b * 114)) / 1000;
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
                    const colorValue = typeof color === 'string' ? color : color.value || color.hex || '#000000';
                    const colorName = color.property || `Color ${index + 1}`;
                    
                    specHtml += `<div class="property-item">
                        <span class="property-name">${colorName}</span>
                        <span class="property-value" style="background: ${colorValue}; padding: 2px 8px; color: ${isLightColor(colorValue) ? '#000' : '#fff'};">${colorValue}</span>
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
                                <span class="property-name">Text Style ${index + 1}</span>
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
                        <span class="property-value" style="background: ${color.hex}; padding: 2px 8px;">${color.hex}</span>
                    </div>`;
                });
                detectedHtml += '</div>';
            }
        }
        
        detectedDisplay.innerHTML = detectedHtml || '<p>Analyzing screenshot...</p>';
    }
    
    // Display detailed analysis
    function displayDetailedAnalysis(report) {
        // Display ALL color comparisons (not just mismatches)
        let colorComparisonHtml = '';
        
        if (report.figmaProperties && report.figmaProperties.colors && report.detectedProperties && report.detectedProperties.colors) {
            // Show all Figma colors with their closest matches
            report.figmaProperties.colors.forEach((figmaColor, index) => {
                const colorName = figmaColor.property || `Color ${index + 1}`;
                const expectedColor = figmaColor.value || figmaColor;
                
                // Find if there's a mismatch for this color
                const mismatch = report.colorMismatches ? 
                    report.colorMismatches.find(m => m.property === figmaColor.property) : null;
                
                // Get the actual detected color
                let detectedColor = '#cccccc'; // Default gray
                if (mismatch) {
                    detectedColor = mismatch.actual === 'Not detected' ? '#cccccc' : mismatch.actual;
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
                for (let i = figmaColorCount; i < report.detectedProperties.colors.length; i++) {
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
        
        document.getElementById('colorComparison').innerHTML = colorComparisonHtml;
        
        // Display property mismatches (excluding colors which are shown above)
        let mismatchHtml = '';
        
        if (report.propertyMismatches && report.propertyMismatches.length > 0) {
            // Filter out color mismatches since they're shown in the color comparison section
            const nonColorMismatches = report.propertyMismatches.filter(m => 
                !m.property.toLowerCase().includes('color')
            );
            
            if (nonColorMismatches.length > 0) {
                nonColorMismatches.forEach(mismatch => {
                    const severity = mismatch.severity || 'major';
                    mismatchHtml += `
                        <div class="mismatch-item ${severity === 'minor' ? 'minor' : ''}">
                            <div class="mismatch-property">${mismatch.property}</div>
                            <div class="mismatch-values">
                                <div class="expected-value">
                                    <div class="value-label">Expected</div>
                                    <div class="value-content">${mismatch.expected}</div>
                                </div>
                                <div class="actual-value">
                                    <div class="value-label">Actual</div>
                                    <div class="value-content">${mismatch.actual || 'Not detected'}</div>
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
        
        document.getElementById('propertyMismatches').innerHTML = mismatchHtml;
        
        // Update category counts
        document.getElementById('colorDiffCount').textContent = report.colorMismatches?.length || '0';
        document.getElementById('spacingDiffCount').textContent = report.spacingMismatches?.length || '0';
        document.getElementById('textDiffCount').textContent = report.textMismatches?.length || '0';
        document.getElementById('sizeDiffCount').textContent = report.sizeMismatches?.length || '0';
    }
    
    // Parse Figma URL to extract file key and node ID
    function parseFigmaUrl(url) {
        try {
            // Example URLs:
            // https://www.figma.com/file/ABC123/File-Name?node-id=1:2
            // https://www.figma.com/file/ABC123/File-Name?node-id=1-2
            // https://www.figma.com/design/ABC123/File-Name?node-id=1-2
            // https://www.figma.com/file/ABC123/File-Name
            
            const urlObj = new URL(url);
            const pathParts = urlObj.pathname.split('/');
            
            // Check for both /file/ and /design/ formats
            if ((pathParts[1] !== 'file' && pathParts[1] !== 'design') || !pathParts[2]) {
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
    async function fetchFigmaDesign(fileKey, nodeId, token) {
        try {
            const response = await fetch('/figma/fetch', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    fileKey: fileKey,
                    nodeId: nodeId,
                    token: token
                })
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to fetch Figma design');
            }
            
            const data = await response.json();
            
            if (data.design) {
                return data.design;
            }
            
            throw new Error('No design data found');
        } catch (error) {
            console.error('Figma API error:', error);
            throw error;
        }
    }
});