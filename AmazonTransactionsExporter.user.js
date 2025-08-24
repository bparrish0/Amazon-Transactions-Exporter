// ==UserScript==
// @name         Amazon Transactions Exporter
// @version      0.6.0
// @description  Export Amazon payment transactions to JSON/CSV
// @author       brandonp0, based on Amazon Orders export by IeuanK
// @url          https://github.com/bparrish0/Amazon-Transactions-Exporter/raw/main/AmazonTransactionsExporter.user.js
// @updateURL    https://github.com/bparrish0/Amazon-Transactions-Exporter/raw/main/AmazonTransactionsExporter.user.js
// @downloadURL  https://github.com/bparrish0/Amazon-Transactions-Exporter/raw/main/AmazonTransactionsExporter.user.js
// @supportURL   https://github.com/bparrish0/Amazon-Transactions-Exporter/issues
// @match        https://www.amazon.com/cpe/yourpayments/transactions*
// @match        https://www.amazon.de/cpe/yourpayments/transactions*
// @match        https://www.amazon.co.uk/cpe/yourpayments/transactions*
// @match        https://www.amazon.nl/cpe/yourpayments/transactions*
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/moment.js/2.29.4/moment.min.js
// ==/UserScript==

(function () {
    "use strict";

    // Main state management
    const STATE_KEY = "amazonTransactionsExporter";
    let state = {
        lastUpdate: null,
        total: 0,
        captures: 0,
        lastTransaction: null,
        transactions: {},
        pagesToCapture: 1, // Default to 1 page
        isMultiPageCapture: false, // Flag to track multi-page operations
        currentMultiPageInfo: null, // Store multi-page capture info
        stopRequested: false, // Flag to request stopping operations
    };

    const conLog = (...args) => {
        console.log(`[Amazon Transactions Exporter]: `, ...args);
    };
    const conError = (...args) => {
        console.error(`[Amazon Transactions Exporter Error]: `, ...args);
    };

    // Load state from localStorage
    const loadState = () => {
        const saved = localStorage.getItem(STATE_KEY);
        if (saved) {
            state = JSON.parse(saved);
        }
        return state;
    };

    // Save state to localStorage
    const saveState = () => {
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
    };

    // Check if pagination is loaded
    const isPaginationLoaded = () => {
        return !document.querySelector(".a-pagination") || !!document.querySelector("ul.a-pagination");
    };

    // Check if we can proceed with operations
    const checkReadiness = () => {
        const pagination = isPaginationLoaded();
        const buttons = document.querySelectorAll("button");
        buttons.forEach(button => {
            button.disabled = !pagination;
        });
        return pagination;
    };

    // URL handling - now handles Amazon's form-based pagination
    const getNextPageUrl = () => {
        // Amazon transactions use form submission, not URL navigation
        // We need to find and click the Next Page button
        return null; // This function is no longer used for navigation
    };

    // Watch for transaction content changes (for AJAX updates)
    const watchForTransactionUpdates = (callback) => {
        const transactionContainer = document.querySelector('form[action*="transactions"]') || document.querySelector('.pmts-widget-section');
        
        if (!transactionContainer) {
            conError('Could not find transaction container to watch');
            return null;
        }

        conLog('Setting up transaction content watcher...');

        const observer = new MutationObserver((mutations) => {
            let hasTransactionChanges = false;
            
            mutations.forEach(mutation => {
                // Check if transaction-related content has changed
                if (mutation.type === 'childList') {
                    const hasTransactionContainers = mutation.target.querySelectorAll('.apx-transactions-line-item-component-container').length > 0;
                    const hasDateContainers = mutation.target.querySelectorAll('.apx-transaction-date-container').length > 0;
                    
                    if (hasTransactionContainers || hasDateContainers || 
                        mutation.addedNodes.length > 0 && Array.from(mutation.addedNodes).some(node => 
                            node.nodeType === Node.ELEMENT_NODE && 
                            (node.classList?.contains('apx-transactions-line-item-component-container') ||
                             node.classList?.contains('apx-transaction-date-container') ||
                             node.querySelector?.('.apx-transactions-line-item-component-container') ||
                             node.querySelector?.('.apx-transaction-date-container'))
                        )) {
                        hasTransactionChanges = true;
                    }
                }
            });

            if (hasTransactionChanges) {
                conLog('Transaction content updated detected!');
                callback();
            }
        });

        // Watch for changes in the transaction container
        observer.observe(transactionContainer, {
            childList: true,
            subtree: true,
            attributes: false,
            characterData: false
        });

        return observer;
    };

    // CSV conversion
    const getCSV = (data = null) => {
        if (!data) {
            data = getJSON();
        }
        const transactions = Object.values(data.transactions);
        if (transactions.length === 0) return "";

        // Find maximum number of items in any transaction
        let maxItems = 0;
        transactions.forEach(transaction => {
            if (transaction.items && transaction.items.length > maxItems) {
                maxItems = transaction.items.length;
            }
        });

        // Base headers - removed TransactionId and Merchant
        const baseHeaders = ["Date", "PaymentMethod", "Amount", "Currency", "OrderId", "Status"];
        
        // Add item columns dynamically
        const itemHeaders = [];
        for (let i = 1; i <= maxItems; i++) {
            itemHeaders.push(`Item${i}`);
        }
        
        const headers = [...baseHeaders, ...itemHeaders];

        // Create rows
        const rows = [];
        transactions.forEach(transaction => {
            const baseRow = [
                transaction.transactionDate,
                transaction.paymentMethod,
                transaction.amount,
                transaction.currency,
                transaction.orderId || "",
                transaction.status || ""
            ];

            // Add item descriptions
            const itemRow = [];
            for (let i = 0; i < maxItems; i++) {
                const item = transaction.items && transaction.items[i] ? transaction.items[i] : "";
                itemRow.push(item);
            }

            const fullRow = [...baseRow, ...itemRow].map(value => `"${value}"`); // Wrap in quotes
            rows.push(fullRow);
        });

        return [headers.join(","), ...rows.map(row => row.join(","))].join("\n");
    };

    // JSON export
    const getJSON = () => {
        return loadState();
    };

    // Parse transaction date
    const parseTransactionDate = (dateText) => {
        if (!dateText || typeof dateText !== "string") {
            console.error("Invalid date text provided:", dateText);
            return null;
        }

        // Define possible date formats for transactions
        const possibleFormats = [
            "MMMM D, YYYY", // e.g., "August 24, 2025"
            "D MMMM YYYY", // e.g., "24 August 2025"
            "MMM D, YYYY", // e.g., "Aug 24, 2025"
            "D MMM YYYY",  // e.g., "24 Aug 2025"
            "YYYY-MM-DD",  // e.g., "2025-08-24"
        ];

        // Attempt parsing
        const trimmedDate = dateText.trim();
        const parsedDate = moment(trimmedDate, possibleFormats, true); // Strict parsing

        if (!parsedDate.isValid()) {
            console.error("Failed to parse transaction date with known formats:", trimmedDate);
            return trimmedDate; // Return original string if parsing fails
        }

        return parsedDate.format("YYYY-MM-DD"); // Standardize format
    };

    // Fetch order page and extract item descriptions
    const fetchOrderItems = async (orderId) => {
        if (!orderId) return [];

        try {
            const orderUrl = `https://www.amazon.com/gp/css/summary/edit.html?orderID=${orderId}`;
            conLog(`Fetching order page: ${orderUrl}`);
            
            const response = await fetch(orderUrl, {
                method: 'GET',
                credentials: 'same-origin',
                headers: {
                    'User-Agent': navigator.userAgent
                }
            });

            if (!response.ok) {
                conError(`Failed to fetch order page: ${response.status} ${response.statusText}`);
                return [];
            }

            const html = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            // Find all img elements with alt attributes
            const imgElements = doc.querySelectorAll('img[alt]');
            const items = [];
            const knownPaymentTypes = ['Amazon Visa', 'American Express'];

            imgElements.forEach(img => {
                const altText = img.alt.trim();
                
                // Skip empty alt text
                if (!altText) return;
                
                // Skip known payment types
                if (knownPaymentTypes.some(paymentType => altText.toLowerCase().includes(paymentType.toLowerCase()))) {
                    return;
                }
                
                // Skip common non-product images
                if (altText.toLowerCase().includes('amazon') && altText.length < 10) return;
                if (altText.toLowerCase().includes('logo')) return;
                if (altText.toLowerCase().includes('icon')) return;
                
                // Add valid item descriptions
                if (altText.length > 0) {
                    items.push(altText);
                }
            });

            conLog(`Found ${items.length} items for order ${orderId}:`, items);
            return items;

        } catch (error) {
            conError(`Error fetching order ${orderId}:`, error);
            return [];
        }
    };

    // Data capture
    const capturePage = async (captureButton, enableButton = true, isMultiPage = false, pageInfo = null) => {
        // Initialize tracking
        captureButton.disabled = true;
        
        // For multi-page capture, calculate total transactions across all pages
        const estimatedTotalTransactions = isMultiPage && pageInfo ? 
            pageInfo.totalPages * 20 : // Assume 20 transactions per page
            0;
        
        const tracking = {
            total: 0,
            captured: 0,
            failed: 0,
            skipped: 0,
            estimatedTotal: estimatedTotalTransactions,
            currentPage: pageInfo?.currentPage || 1,
            totalPages: pageInfo?.totalPages || 1,
        };

        // Find status span and update it
        const statusSpan = document.querySelector(".capture-status");
        const updateStatus = () => {
            if (statusSpan) {
                if (isMultiPage) {
                    const globalProgress = (pageInfo.currentPage - 1) * 20 + tracking.captured;
                    statusSpan.textContent = `Page ${tracking.currentPage}/${tracking.totalPages}: ${globalProgress}/${tracking.estimatedTotal} transactions captured, ${tracking.failed} failed, ${tracking.skipped} skipped. Fetching items...`;
                } else {
                    statusSpan.textContent = `${tracking.captured}/${tracking.total} transactions captured, ${tracking.failed} failed, ${tracking.skipped} skipped. Fetching items...`;
                }
            }
        };

        // Load current state
        loadState();

        // Initialize transactions object for this page
        const newTransactions = {};

        // Find all transaction date containers on the page
        const dateContainers = document.querySelectorAll(".apx-transaction-date-container");
        if (!dateContainers.length) {
            conLog("No transaction date containers found on page");
            if (enableButton) {
                captureButton.disabled = false;
            }
            return false;
        }

        // Count total transactions first
        for (const dateContainer of dateContainers) {
            const nextSibling = dateContainer.nextElementSibling;
            if (nextSibling) {
                const lineItemContainers = nextSibling.querySelectorAll(".apx-transactions-line-item-component-container");
                tracking.total += lineItemContainers.length;
            }
        }

        for (const dateContainer of dateContainers) {
            try {
                // Extract transaction date
                const dateSpan = dateContainer.querySelector("span");
                if (!dateSpan) {
                    conLog("No date span found in date container");
                    continue;
                }
                const transactionDateText = dateSpan.textContent.trim();
                const transactionDate = parseTransactionDate(transactionDateText);

                // Find all transaction line items within this date group
                const nextSibling = dateContainer.nextElementSibling;
                if (!nextSibling) continue;

                const lineItemContainers = nextSibling.querySelectorAll(".apx-transactions-line-item-component-container");
                
                for (const lineItemContainer of lineItemContainers) {
                    try {
                        // Extract payment method and amount from first row
                        const firstRow = lineItemContainer.querySelector(".a-row");
                        if (!firstRow) {
                            conLog("No first row found in line item container");
                            tracking.failed++;
                            updateStatus();
                            continue;
                        }

                        // Payment method (e.g., "Prime Visa ****5989")
                        const paymentMethodSpan = firstRow.querySelector(".a-span9 .a-text-bold");
                        const paymentMethod = paymentMethodSpan ? paymentMethodSpan.textContent.trim() : "";

                        // Amount (e.g., "-$27.91")
                        const amountSpan = firstRow.querySelector(".a-span3 .a-text-bold");
                        if (!amountSpan) {
                            conLog("No amount span found");
                            tracking.failed++;
                            updateStatus();
                            continue;
                        }
                        const amountText = amountSpan.textContent.trim();
                        const currency = amountText.startsWith("$") ? "USD" : 
                                       amountText.startsWith("€") ? "EUR" : 
                                       amountText.startsWith("£") ? "GBP" : "USD";
                        const amount = parseFloat(amountText.replace(/[^0-9.-]/g, ""));

                        // Extract order ID from link (if present)
                        const orderLink = lineItemContainer.querySelector("a[href*='orderID=']");
                        let orderId = "";
                        let status = "";
                        if (orderLink) {
                            const href = orderLink.href;
                            const orderMatch = href.match(/orderID=([^&]+)/);
                            if (orderMatch) {
                                orderId = orderMatch[1];
                            }
                            // Check for status in the same section
                            const statusSpan = lineItemContainer.querySelector(".a-color-base");
                            if (statusSpan) {
                                status = statusSpan.textContent.trim();
                            }
                        }

                        // Extract merchant information
                        const merchantSpan = lineItemContainer.querySelector("span.a-size-base:not(.a-text-bold):not(.a-color-base)");
                        const merchant = merchantSpan ? merchantSpan.textContent.trim() : "";

                        // Fetch item descriptions from order page (sped up by 50%)
                        let items = [];
                        if (orderId) {
                            conLog(`Fetching items for order ${orderId}...`);
                            items = await fetchOrderItems(orderId);
                            // Reduced delay from 500ms to 250ms (50% faster)
                            await new Promise(resolve => setTimeout(resolve, 250));
                        }

                        // Create unique transaction ID
                        const transactionId = `${transactionDate}_${orderId || Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

                        // Skip if already captured (by checking similar transactions)
                        const existingKey = Object.keys(state.transactions).find(key => {
                            const existing = state.transactions[key];
                            return existing.transactionDate === transactionDate &&
                                   existing.orderId === orderId &&
                                   existing.amount === amount &&
                                   existing.paymentMethod === paymentMethod;
                        });

                        if (existingKey) {
                            tracking.skipped++;
                            // Add orange border for skipped transactions
                            lineItemContainer.style.border = "2px solid #ffa500";
                            updateStatus();
                            continue;
                        }

                        newTransactions[transactionId] = {
                            transactionId: transactionId,
                            transactionDate: transactionDate,
                            paymentMethod: paymentMethod,
                            amount: amount,
                            currency: currency,
                            orderId: orderId,
                            status: status,
                            merchant: merchant,
                            items: items
                        };

                        // Add green border for successfully captured transactions
                        lineItemContainer.style.border = "2px solid #00aa00";

                        tracking.captured++;

                    } catch (err) {
                        conError("Error processing transaction line item:", err);
                        tracking.failed++;

                        // Add visual error indication
                        lineItemContainer.style.border = "2px solid #ff0000";
                    }
                    
                    updateStatus();
                }

            } catch (err) {
                conError("Error processing date container:", err);
                tracking.failed++;
            }
        }

        // Merge new transactions with existing state
        if (Object.keys(newTransactions).length > 0) {
            state.transactions = { ...state.transactions, ...newTransactions };
            state.captures++;
            state.total = Object.keys(state.transactions).length;
            state.lastUpdate = new Date().toLocaleString();
            
            // Store multi-page info if applicable
            if (isMultiPage && pageInfo) {
                state.currentMultiPageInfo = pageInfo;
                state.isMultiPageCapture = true;
            }
            
            saveState();
            
            const totalNewItems = Object.values(newTransactions).reduce((sum, transaction) => {
                return sum + (transaction.items ? transaction.items.length : 0);
            }, 0);
            
            conLog(`Captured ${Object.keys(newTransactions).length} new transactions with ${totalNewItems} total items`);
        }

        // Update final status
        if (statusSpan) {
            if (isMultiPage) {
                const globalProgress = (pageInfo.currentPage - 1) * 20 + tracking.captured;
                statusSpan.textContent = `Page ${tracking.currentPage}/${tracking.totalPages}: ${globalProgress}/${tracking.estimatedTotal} transactions captured, ${tracking.failed} failed, ${tracking.skipped} skipped`;
            } else {
                statusSpan.textContent = `${tracking.captured}/${tracking.total} transactions captured, ${tracking.failed} failed, ${tracking.skipped} skipped`;
            }
        }

        if (enableButton) {
            captureButton.disabled = false;
        }
        return Object.keys(newTransactions).length > 0;
    };

    // Navigate to next page by clicking the Next Page button
    const navigateToNextPage = () => {
        // Look for the Next Page button
        const nextPageButton = document.querySelector('input[name*="NextPageNavigationEvent"]');
        if (nextPageButton) {
            conLog('Found Next Page button, clicking...');
            nextPageButton.click();
            return true;
        }

        // Alternative: look for button with "Next Page" text
        const buttons = document.querySelectorAll('input[type="submit"], button');
        for (const button of buttons) {
            const buttonText = button.textContent || button.value || '';
            const siblingText = button.parentElement?.textContent || '';
            if (buttonText.includes('Next Page') || siblingText.includes('Next Page')) {
                conLog('Found Next Page button via text search, clicking...');
                button.click();
                return true;
            }
        }

        // Look for the specific Amazon structure
        const nextSpan = Array.from(document.querySelectorAll('span.a-button-text')).find(span => 
            span.textContent.trim() === 'Next Page'
        );
        if (nextSpan) {
            const submitInput = nextSpan.parentElement?.querySelector('input[type="submit"]');
            if (submitInput) {
                conLog('Found Next Page button via span structure, clicking...');
                submitInput.click();
                return true;
            }
        }

        conLog('No Next Page button found');
        return false;
    };

    // Multi-page capture with AJAX watching
    const captureMultiplePagesWithWatcher = async (button, numPages) => {
        button.disabled = true;
        let currentPage = 1;
        const originalText = button.innerHTML;
        
        // Store multi-page info in state
        state.isMultiPageCapture = true;
        state.currentMultiPageInfo = {
            totalPages: numPages,
            currentPage: currentPage
        };
        saveState();

        const processNextPage = async () => {
            if (currentPage > numPages) {
                // All pages completed
                conLog(`Multi-page capture completed. Processed ${numPages} pages.`);
                state.isMultiPageCapture = false;
                state.currentMultiPageInfo = null;
                saveState();
                button.innerHTML = originalText;
                button.disabled = false;
                updatePanelUI(document.querySelector(".amazon-transactions-exporter-panel"));
                
                const statusSpan = document.querySelector(".capture-status");
                if (statusSpan) {
                    statusSpan.textContent = `Multi-page capture completed! Processed ${numPages} pages.`;
                }
                return;
            }

            button.innerHTML = `📄 ${currentPage}/${numPages}`;
            conLog(`Capturing page ${currentPage} of ${numPages}...`);

            // Capture current page
            const pageInfo = {
                currentPage: currentPage,
                totalPages: numPages
            };

            try {
                const captured = await capturePage(button, false, true, pageInfo);
                conLog(`Page ${currentPage} capture completed, captured new data: ${captured}`);

                // Move to next page if not the last page
                if (currentPage < numPages) {
                    conLog(`Setting up watcher for next page navigation...`);
                    
                    // Set up watcher for content changes
                    const observer = watchForTransactionUpdates(() => {
                        conLog(`Transaction content changed, continuing to page ${currentPage + 1}`);
                        observer.disconnect(); // Stop watching
                        currentPage++;
                        state.currentMultiPageInfo.currentPage = currentPage;
                        saveState();
                        
                        // Small delay to let content settle
                        setTimeout(() => {
                            processNextPage();
                        }, 1000);
                    });

                    if (observer) {
                        // Navigate to next page
                        const navigated = navigateToNextPage();
                        if (!navigated) {
                            conLog('Navigation failed, ending multi-page capture');
                            observer.disconnect();
                            state.isMultiPageCapture = false;
                            state.currentMultiPageInfo = null;
                            saveState();
                            button.innerHTML = originalText;
                            button.disabled = false;
                            updatePanelUI(document.querySelector(".amazon-transactions-exporter-panel"));
                            return;
                        }
                        
                        // Set timeout as backup in case watcher doesn't trigger
                        setTimeout(() => {
                            conLog('Watcher timeout, forcing next page processing');
                            observer.disconnect();
                            currentPage++;
                            state.currentMultiPageInfo.currentPage = currentPage;
                            saveState();
                            processNextPage();
                        }, 10000); // 10 second timeout
                    } else {
                        // Fallback to time-based approach
                        const navigated = navigateToNextPage();
                        if (navigated) {
                            setTimeout(() => {
                                currentPage++;
                                state.currentMultiPageInfo.currentPage = currentPage;
                                saveState();
                                processNextPage();
                            }, 3000);
                        } else {
                            state.isMultiPageCapture = false;
                            state.currentMultiPageInfo = null;
                            saveState();
                            button.innerHTML = originalText;
                            button.disabled = false;
                        }
                    }
                } else {
                    // Last page, finish up
                    currentPage++;
                    processNextPage();
                }
            } catch (error) {
                conError('Error during page capture:', error);
                state.isMultiPageCapture = false;
                state.currentMultiPageInfo = null;
                saveState();
                button.innerHTML = originalText;
                button.disabled = false;
            }
        };

        // Start the process
        processNextPage();
    };

    // File downloads
    const downloadFile = (content, filename, type) => {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    // Create floating panel
    const createPanel = () => {
        const panel = document.createElement("div");
        panel.className = "amazon-transactions-exporter-panel";
        panel.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            width: 320px;
            background: white;
            border: 2px solid #232f3e;
            border-radius: 5px;
            padding: 15px;
            font-family: 'Amazon Ember', Arial, sans-serif;
            font-size: 13px;
            z-index: 10000;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        `;
        return panel;
    };

    // Confirmation dialog
    const createConfirmDialog = (message, onConfirm) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10001;
    `;

        const dialog = document.createElement("div");
        dialog.style.cssText = `
        background: white;
        padding: 20px;
        border-radius: 5px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
        text-align: center;
        font-family: 'Amazon Ember', Arial, sans-serif;
    `;

        const text = document.createElement("p");
        text.textContent = message;
        text.style.marginBottom = "20px";

        const buttonContainer = document.createElement("div");
        buttonContainer.style.display = "flex";
        buttonContainer.style.gap = "10px";
        buttonContainer.style.justifyContent = "center";

        const confirmButton = document.createElement("button");
        confirmButton.textContent = "Yes";
        confirmButton.style.cssText = `
        padding: 8px 16px;
        background: #ff6b35;
        color: white;
        border: none;
        border-radius: 3px;
        cursor: pointer;
    `;
        confirmButton.addEventListener("mouseover", () => confirmButton.style.background = "#e55a2b");
        confirmButton.addEventListener("mouseout", () => confirmButton.style.background = "#ff6b35");
        confirmButton.addEventListener("click", () => {
            document.body.removeChild(overlay);
            onConfirm();
        });

        const cancelButton = document.createElement("button");
        cancelButton.textContent = "No";
        cancelButton.style.cssText = `
        padding: 8px 16px;
        background: white;
        color: #333;
        border: 1px solid #ddd;
        border-radius: 3px;
        cursor: pointer;
    `;
        cancelButton.addEventListener("mouseover", () => cancelButton.style.background = "#f0f0f0");
        cancelButton.addEventListener("mouseout", () => cancelButton.style.background = "white");
        cancelButton.addEventListener("click", () => document.body.removeChild(overlay));

        buttonContainer.appendChild(cancelButton);
        buttonContainer.appendChild(confirmButton);
        dialog.appendChild(text);
        dialog.appendChild(buttonContainer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    };

    // Preview modal
    const createPreviewModal = (content, type) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10001;
    `;

        const modal = document.createElement("div");
        modal.style.cssText = `
        background: white;
        padding: 20px;
        border-radius: 5px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
        max-width: 80%;
        max-height: 80%;
        overflow: auto;
    `;

        const closeButton = document.createElement("button");
        closeButton.textContent = "Close";
        closeButton.style.cssText = `
        position: absolute;
        top: 10px;
        right: 10px;
        padding: 5px 10px;
        background: #f44336;
        color: white;
        border: none;
        border-radius: 3px;
        cursor: pointer;
    `;
        closeButton.onclick = () => document.body.removeChild(overlay);

        if (type === "json") {
            const pre = document.createElement("pre");
            const code = document.createElement("code");
            code.textContent = content;
            pre.appendChild(code);
            modal.appendChild(pre);
        } else if (type === "csv") {
            const table = document.createElement("table");
            table.style.borderCollapse = "collapse";
            const rows = content.split("\n");
            rows.forEach((row, index) => {
                const tr = document.createElement("tr");
                let splitString = `,`;
                if(row.indexOf(`","`) !== -1) {
                    splitString = `","`;
                }
                row.split(splitString).forEach(cell => {
                    const td = document.createElement(index === 0 ? "th" : "td");
                    td.textContent = cell.replace(/^"|"$/g, "");
                    td.style.border = "1px solid #ddd";
                    td.style.padding = "8px";
                    tr.appendChild(td);
                });
                table.appendChild(tr);
            });
            modal.appendChild(table);
        }

        modal.appendChild(closeButton);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    };

    const createButton = (icon, tooltip, onClick) => {
        const button = document.createElement("button");
        button.innerHTML = icon;
        button.title = tooltip;
        button.style.cssText = `
            margin: 5px;
            padding: 8px;
            border: 1px solid #ccc;
            border-radius: 3px;
            cursor: pointer;
            background: #f8f8f8;
            width: 36px;
            height: 36px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-family: sans-serif;
            position: relative;
        `;

        // Add hover styles
        button.addEventListener("mouseover", () => {
            button.style.background = "#e9e9e9";
        });
        button.addEventListener("mouseout", () => {
            button.style.background = "#f8f8f8";
        });

        button.addEventListener("click", onClick);
        return button;
    };

    // Update panel UI based on state
    const updatePanelUI = (panel) => {
        // Clear panel
        panel.innerHTML = "";

        // Add title
        const title = document.createElement("div");
        title.textContent = "Amazon Transactions Exporter";
        title.style.cssText = `
            font-weight: bold;
            margin-bottom: 10px;
            font-size: 1.1em;
            color: #232f3e;
        `;
        panel.appendChild(title);

        // Show capture info with placeholder spaces
        const info = document.createElement("div");
        info.className = "captures-list";
        info.style.cssText = `
            margin: 10px 0;
            min-height: 80px;  /* Space for 4 lines */
        `;

        const state = loadState();
        const totalItems = Object.values(state.transactions || {}).reduce((sum, transaction) => {
            return sum + (transaction.items ? transaction.items.length : 0);
        }, 0);
        
        info.innerHTML = `
            <div style="min-height: 20px">Total Transactions: ${state.total || ""}</div>
            <div style="min-height: 20px">Total Items: ${totalItems || ""}</div>
            <div style="min-height: 20px">Pages Captured: ${state.captures || ""}</div>
            <div style="min-height: 20px">Last Update: ${state.lastUpdate || ""}</div>
        `;
        panel.appendChild(info);

        // Add pages to capture selector
        const pagesContainer = document.createElement("div");
        pagesContainer.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 10px;
            padding: 5px;
            border: 1px solid #ddd;
            border-radius: 3px;
            background: #f9f9f9;
        `;

        const pagesLabel = document.createElement("span");
        pagesLabel.textContent = "Pages to capture:";
        pagesLabel.style.cssText = `
            font-size: 0.9em;
            color: #333;
        `;

        const pagesInputContainer = document.createElement("div");
        pagesInputContainer.style.cssText = `
            display: flex;
            align-items: center;
            gap: 5px;
        `;

        const decreaseButton = document.createElement("button");
        decreaseButton.textContent = "−";
        decreaseButton.style.cssText = `
            width: 25px;
            height: 25px;
            border: 1px solid #ccc;
            border-radius: 3px;
            background: #f8f8f8;
            cursor: pointer;
            font-weight: bold;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        const pagesInput = document.createElement("input");
        pagesInput.type = "number";
        pagesInput.value = state.pagesToCapture || 1;
        pagesInput.min = "1";
        pagesInput.max = "50";
        pagesInput.style.cssText = `
            width: 50px;
            height: 25px;
            border: 1px solid #ccc;
            border-radius: 3px;
            text-align: center;
            font-size: 0.9em;
            -moz-appearance: textfield;
        `;
        
        // Hide spinner arrows in WebKit browsers
        const style = document.createElement("style");
        style.textContent = `
            input[type=number]::-webkit-outer-spin-button,
            input[type=number]::-webkit-inner-spin-button {
                -webkit-appearance: none;
                margin: 0;
            }
        `;
        if (!document.head.querySelector('style[data-spinner-hidden]')) {
            style.setAttribute('data-spinner-hidden', 'true');
            document.head.appendChild(style);
        }

        const increaseButton = document.createElement("button");
        increaseButton.textContent = "+";
        increaseButton.style.cssText = `
            width: 25px;
            height: 25px;
            border: 1px solid #ccc;
            border-radius: 3px;
            background: #f8f8f8;
            cursor: pointer;
            font-weight: bold;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        // Button event handlers
        decreaseButton.addEventListener("click", () => {
            const currentValue = parseInt(pagesInput.value) || 1;
            if (currentValue > 1) {
                pagesInput.value = currentValue - 1;
                state.pagesToCapture = currentValue - 1;
                saveState();
            }
        });

        increaseButton.addEventListener("click", () => {
            const currentValue = parseInt(pagesInput.value) || 1;
            if (currentValue < 50) {
                pagesInput.value = currentValue + 1;
                state.pagesToCapture = currentValue + 1;
                saveState();
            }
        });

        pagesInput.addEventListener("change", () => {
            let value = parseInt(pagesInput.value) || 1;
            value = Math.max(1, Math.min(50, value)); // Clamp between 1 and 50
            pagesInput.value = value;
            state.pagesToCapture = value;
            saveState();
        });

        // Add hover effects
        [decreaseButton, increaseButton].forEach(btn => {
            btn.addEventListener("mouseenter", () => btn.style.background = "#e9e9e9");
            btn.addEventListener("mouseleave", () => btn.style.background = "#f8f8f8");
        });

        pagesInputContainer.appendChild(decreaseButton);
        pagesInputContainer.appendChild(pagesInput);
        pagesInputContainer.appendChild(increaseButton);

        pagesContainer.appendChild(pagesLabel);
        pagesContainer.appendChild(pagesInputContainer);
        panel.appendChild(pagesContainer);

        // Add status span for capture progress
        const statusSpan = document.createElement("div");
        statusSpan.className = "capture-status";
        statusSpan.style.cssText = `
            min-height: 20px;
            margin-bottom: 10px;
            color: #666;
            font-size: 0.9em;
        `;
        panel.appendChild(statusSpan);

        const buttonContainer = document.createElement("div");
        buttonContainer.style.display = "flex";
        buttonContainer.style.alignItems = "center";
        buttonContainer.style.gap = "5px";

        // Add control buttons
        const startButton = createButton(
            "📸",
            state.captures === 0 ? 
                "Start capturing transactions from current page" : 
                "Continue capturing transactions from current page",
            () => {
                const pagesToCapture = parseInt(pagesInput.value) || 1;
                if (pagesToCapture === 1) {
                    capturePage(startButton);
                } else {
                    captureMultiplePagesWithWatcher(startButton, pagesToCapture);
                }
            }
        );

        const csvButton = createButton(
            "📊",
            "Download transactions as CSV",
            () => {
                const csv = getCSV();
                if (!csv) {
                    alert("No transactions data to export. Please capture some transactions first.");
                    return;
                }
                downloadFile(csv, "amazon-transactions.csv", "text/csv");
            }
        );

        const jsonButton = createButton(
            "📄",
            "Download transactions as JSON",
            () => {
                const json = JSON.stringify(getJSON(), null, 2);
                if (!json || json === "{}") {
                    alert("No transactions data to export. Please capture some transactions first.");
                    return;
                }
                downloadFile(json, "amazon-transactions.json", "application/json");
            }
        );

        const previewCsvButton = createButton(
            "👁",
            "Preview CSV data",
            () => {
                const csv = getCSV();
                if (!csv) {
                    alert("No transactions data to preview. Please capture some transactions first.");
                    return;
                }
                createPreviewModal(csv, "csv");
            }
        );

        const previewJsonButton = createButton(
            "🔍",
            "Preview JSON data",
            () => {
                const json = JSON.stringify(getJSON(), null, 2);
                if (!json || json === "{}") {
                    alert("No transactions data to preview. Please capture some transactions first.");
                    return;
                }
                createPreviewModal(json, "json");
            }
        );

        // Add buttons to container
        buttonContainer.appendChild(startButton);
        buttonContainer.appendChild(csvButton);
        buttonContainer.appendChild(jsonButton);
        buttonContainer.appendChild(previewCsvButton);
        buttonContainer.appendChild(previewJsonButton);

        // Add clear button
        const clearButton = createButton("🗑", "Clear all captured data", () => {
            createConfirmDialog("Are you sure you want to clear all captured transaction data?", () => {
                localStorage.removeItem(STATE_KEY);
                window.location.reload();
            });
        });
        clearButton.style.marginLeft = "auto"; // Push to right side
        buttonContainer.appendChild(clearButton);

        buttonContainer.appendChild(startButton);
        panel.appendChild(buttonContainer);
    };

    // Main initialization
    const init = () => {
        const panel = createPanel();
        updatePanelUI(panel);
        document.body.appendChild(panel);

        // Check if we're in the middle of a multi-page capture (for page reloads)
        loadState();
        if (state.isMultiPageCapture && state.currentMultiPageInfo) {
            conLog(`Detected incomplete multi-page capture state - cleaning up`);
            // Since we're using AJAX watching now, clean up any orphaned multi-page state
            state.isMultiPageCapture = false;
            state.currentMultiPageInfo = null;
            saveState();
        }

        // Initial readiness check
        if (!checkReadiness()) {
            // Set up a retry mechanism
            let attempts = 0;
            const maxAttempts = 20; // 10 seconds total (20 * 500ms)

            const checkInterval = setInterval(() => {
                attempts++;
                if (checkReadiness() || attempts >= maxAttempts) {
                    clearInterval(checkInterval);
                }
            }, 500);
        }
    };

    conLog(`Checking URL`);
    // Check if we're on a transactions page
    if (
        window.location.href.match(/\/cpe\/yourpayments\/transactions/) ||
        window.location.href.match(/\/transactions/)
    ) {
        try {
            conLog(`Loading transactions exporter script`);
            init();
        } catch (error) {
            conError(error);
        }
    }
})();
