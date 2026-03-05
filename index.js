const { BrowserWindow, screen, ipcMain, app } = require('electron');
const path = require('path');

// Global reference to prevent garbage collection
let overlayWindow = null;
const widgets = new Map();
let isRendererReady = false;
const pendingWidgets = [];
let isDragging = false;
let topMostInterval = null;
let boundsCheckInterval = null;
let heartbeatInterval = null;
let lastHeartbeat = Date.now();
let missedHeartbeats = 0;

// IPC Channels
const CHANNELS = {
    ADD: 'service.toplayer:add-widget',
    REMOVE: 'service.toplayer:remove-widget',
    UPDATE: 'service.toplayer:update-widget',
    SET_SHAPE: 'service.toplayer:set-window-shape',
    START_DRAG: 'service.toplayer:start-drag',
    DRAG_END: 'service.toplayer:drag-end',
    SHOW_OVERLAY: 'service.toplayer:show-overlay',
    HIDE_OVERLAY: 'service.toplayer:hide-overlay',
    HEARTBEAT: 'service.toplayer:heartbeat',
    HEARTBEAT_RESPONSE: 'service.toplayer:heartbeat-response'
};

let pluginApi = null;

/**
 * Handle shape updates from renderer to enable click-through
 */
const onSetShape = (event, payload) => {
    console.log('[Service.TopLayer] onSetShape called, isDragging:', isDragging);
    if (isDragging) {
        console.log('[Service.TopLayer] BLOCKED shape update during drag');
        return;
    }
    
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!senderWin || (overlayWindow && senderWin.id !== overlayWindow.id)) return;
    if (!overlayWindow || overlayWindow.isDestroyed()) return;

    let rects = [];
    let passThroughMode = false;

    // Handle both old array format and new object format
    if (Array.isArray(payload)) {
        rects = payload;
    } else if (payload && typeof payload === 'object') {
        rects = payload.rects || [];
        passThroughMode = !!payload.passThroughMode;
    }

    if (passThroughMode) {
        try {
            overlayWindow.setShape(rects);
            overlayWindow.setIgnoreMouseEvents(true, { forward: true });
        } catch (e) {
            console.error('[Service.TopLayer] Failed to set pass-through shape', e);
        }
    } else {
        if (!Array.isArray(rects) || rects.length === 0) {
            overlayWindow.setIgnoreMouseEvents(true, { forward: true });
            try { overlayWindow.setShape([]); } catch(e) {}
        } else {
            try {
                overlayWindow.setShape(rects);
                overlayWindow.setIgnoreMouseEvents(false);
            } catch (e) {
                console.error('[Service.TopLayer] Failed to set shape', e);
            }
        }
    }
};

/**
 * Ensure window stays on top - call periodically
 */
function ensureTopMost() {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    
    try {
        // Force re-apply always on top - this helps when another fullscreen window takes over
        // Toggle off then on to force OS to recognize the top-most state
        overlayWindow.setAlwaysOnTop(false);
        overlayWindow.setAlwaysOnTop(true, 'screen-saver');
        
        // Use moveTop to bring window to front
        try {
            overlayWindow.moveTop();
        } catch (e) {}
        
        // Ensure window is visible
        if (!overlayWindow.isVisible()) {
            overlayWindow.show();
        }
        
        // On Windows, sometimes need to re-set bounds to ensure coverage
        if (process.platform === 'win32') {
            const displays = screen.getAllDisplays();
            // Check if window covers all displays
            const winBounds = overlayWindow.getBounds();
            let needsResize = false;
            
            for (const display of displays) {
                const db = display.bounds;
                if (db.x < winBounds.x || db.y < winBounds.y ||
                    db.x + db.width > winBounds.x + winBounds.width ||
                    db.y + db.height > winBounds.y + winBounds.height) {
                    needsResize = true;
                    break;
                }
            }
            
            if (needsResize) {
                // Calculate union of all display bounds
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const display of displays) {
                    const db = display.bounds;
                    minX = Math.min(minX, db.x);
                    minY = Math.min(minY, db.y);
                    maxX = Math.max(maxX, db.x + db.width);
                    maxY = Math.max(maxY, db.y + db.height);
                }
                overlayWindow.setBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
            }
        }
    } catch (e) {
        console.error('[Service.TopLayer] Error in ensureTopMost:', e);
    }
}

/**
 * Calculate bounds that cover all displays
 */
function getCombinedDisplayBounds() {
    const displays = screen.getAllDisplays();
    if (displays.length === 0) {
        return screen.getPrimaryDisplay().bounds;
    }
    
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const display of displays) {
        const db = display.bounds;
        minX = Math.min(minX, db.x);
        minY = Math.min(minY, db.y);
        maxX = Math.max(maxX, db.x + db.width);
        maxY = Math.max(maxY, db.y + db.height);
    }
    
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function createWindow() {
    isRendererReady = false;
    
    // Repopulate pending from existing widgets map
    pendingWidgets.length = 0;
    for (const [id, opts] of widgets) {
        pendingWidgets.push(opts);
    }
    
    // Get combined bounds of all displays
    const bounds = getCombinedDisplayBounds();
    const { x, y, width, height } = bounds;

    overlayWindow = new BrowserWindow({
        x, y, width, height,
        type: 'toolbar',
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        focusable: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false,
            webviewTag: true,
            backgroundThrottling: false
        }
    });

    // Set highest always-on-top level
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    
    // On macOS, make visible on all workspaces
    if (process.platform === 'darwin') {
        try {
            overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        } catch (e) {}
    }
    
    // Explicitly set bounds
    overlayWindow.setBounds({ x, y, width, height });

    // Initial state: click-through
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });

    overlayWindow.loadFile(path.join(__dirname, 'index.html'));

    // Handle window being hidden or minimized - restore it
    overlayWindow.on('hide', () => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            setTimeout(() => {
                try {
                    if (overlayWindow && !overlayWindow.isDestroyed()) {
                        overlayWindow.show();
                    }
                } catch (e) {}
            }, 100);
        }
    });
    
    overlayWindow.on('minimize', () => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            try {
                overlayWindow.restore();
            } catch (e) {}
        }
    });

    overlayWindow.on('closed', () => {
        overlayWindow = null;
        widgets.clear();
        isRendererReady = false;
        pendingWidgets.length = 0;
    });
    
    // Start periodic top-most check
    startTopMostCheck();
    
    // Start heartbeat detection
    startHeartbeat();
}

/**
 * Start periodic checks to ensure window stays on top
 */
function startTopMostCheck() {
    // Clear existing intervals
    if (topMostInterval) {
        clearInterval(topMostInterval);
    }
    if (boundsCheckInterval) {
        clearInterval(boundsCheckInterval);
    }
    
    // Check every 2 seconds
    topMostInterval = setInterval(ensureTopMost, 2000);
    
    // Check bounds every 5 seconds (for display changes)
    boundsCheckInterval = setInterval(() => {
        if (!overlayWindow || overlayWindow.isDestroyed()) return;
        
        const currentBounds = overlayWindow.getBounds();
        const targetBounds = getCombinedDisplayBounds();
        
        // If bounds don't match, update
        if (currentBounds.x !== targetBounds.x ||
            currentBounds.y !== targetBounds.y ||
            currentBounds.width !== targetBounds.width ||
            currentBounds.height !== targetBounds.height) {
            console.log('[Service.TopLayer] Display bounds changed, updating window');
            overlayWindow.setBounds(targetBounds);
        }
    }, 5000);
}

/**
 * Stop periodic checks
 */
function stopTopMostCheck() {
    if (topMostInterval) {
        clearInterval(topMostInterval);
        topMostInterval = null;
    }
    if (boundsCheckInterval) {
        clearInterval(boundsCheckInterval);
        boundsCheckInterval = null;
    }
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

/**
 * Start heartbeat to detect frozen renderer
 */
function startHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }
    
    missedHeartbeats = 0;
    lastHeartbeat = Date.now();
    
    // Send heartbeat every 3 seconds, expect response within 5 seconds
    heartbeatInterval = setInterval(() => {
        if (!overlayWindow || overlayWindow.isDestroyed()) {
            return;
        }
        
        // Check if we missed too many heartbeats
        const now = Date.now();
        if (now - lastHeartbeat > 10000) {
            missedHeartbeats++;
            console.warn(`[Service.TopLayer] Missed heartbeat (${missedHeartbeats})`);
            
            if (missedHeartbeats >= 3) {
                console.error('[Service.TopLayer] Renderer appears frozen, recreating window');
                missedHeartbeats = 0;
                
                // Destroy and recreate window
                try {
                    if (overlayWindow && !overlayWindow.isDestroyed()) {
                        overlayWindow.destroy();
                    }
                } catch (e) {}
                overlayWindow = null;
                isRendererReady = false;
                createWindow();
                return;
            }
        }
        
        // Send heartbeat ping
        try {
            overlayWindow.webContents.send(CHANNELS.HEARTBEAT);
        } catch (e) {
            console.error('[Service.TopLayer] Failed to send heartbeat:', e);
        }
    }, 3000);
}

/**
 * Handle heartbeat response from renderer
 */
function handleHeartbeatResponse() {
    lastHeartbeat = Date.now();
    missedHeartbeats = 0;
}

// Public API Functions
const functions = {
    // Force bring to front - call when needed
    forceToFront: () => {
        if (!overlayWindow || overlayWindow.isDestroyed()) return false;
        try {
            overlayWindow.setAlwaysOnTop(false);
            overlayWindow.setAlwaysOnTop(true, 'screen-saver');
            overlayWindow.moveTop();
            overlayWindow.show();
            return true;
        } catch (e) {
            console.error('[Service.TopLayer] forceToFront failed:', e);
            return false;
        }
    },
    
    addWidget: (options) => {
        // Fix: Ensure we have an ID before anything else
        if (!options || !options.id) {
             console.error('[Service.TopLayer] addWidget called without valid options or id. Received:', JSON.stringify(options));
             return false;
        }

        if (!overlayWindow || overlayWindow.isDestroyed()) {
             // If window is missing (e.g. crashed), try to recreate it?
             // Or just return false.
             console.warn('[Service.TopLayer] Window not ready, attempting to create...');
             createWindow();
             // Wait for window? No, just fail this time or queue it.
             // For simplicity, fail but log.
             return false; 
        }
        
        console.log(`[Service.TopLayer] Adding widget: ${options.id} at (${options.x}, ${options.y})`);
        widgets.set(options.id, options);
        
        if (isRendererReady) {
            overlayWindow.webContents.send(CHANNELS.ADD, options);
        } else {
            console.log(`[Service.TopLayer] Renderer not ready, queuing widget: ${options.id}`);
            pendingWidgets.push(options);
        }
        return true;
    },

    removeWidget: (id) => {
        if (!overlayWindow) return false;
        if (!widgets.has(id)) return false;
        widgets.delete(id);
        overlayWindow.webContents.send(CHANNELS.REMOVE, id);
        return true;
    },

    updateWidget: (id, bounds) => {
        if (!overlayWindow) return false;
        if (!widgets.has(id)) return false;
        
        const current = widgets.get(id);
        const updated = { ...current, ...bounds };
        widgets.set(id, updated);
        
        overlayWindow.webContents.send(CHANNELS.UPDATE, { id, ...bounds });
        return true;
    },

    startDrag: (arg1, arg2) => {
        let id, options;
        if (typeof arg1 === 'object' && arg1 !== null) {
             id = arg1.id;
             options = arg1;
        } else {
             id = arg1;
             options = arg2 || {};
        }

        if (!overlayWindow || !widgets.has(id)) return false;
        
        console.log('[Service.TopLayer] startDrag called for:', id, 'isTouch:', options.isTouch);
        isDragging = true;
        
        try {
            console.log('[Service.TopLayer] Setting full screen shape');
            overlayWindow.setShape([{ x: 0, y: 0, width: 99999, height: 99999 }]);
            overlayWindow.setIgnoreMouseEvents(false);
            console.log('[Service.TopLayer] Full screen shape set successfully');
        } catch (e) {
            console.error('[Service.TopLayer] Failed to set drag shape', e);
        }
        
        // Notify renderer to start listening for drag events
        // Pass isTouch to determine drag mode
        overlayWindow.webContents.send(CHANNELS.START_DRAG, { 
            id,
            isTouch: options.isTouch || false
        });
        
        return true;
    },

    endDrag: (arg1, arg2) => {
        let id, x, y;
        if (typeof arg1 === 'object' && arg1 !== null) {
            id = arg1.id;
            x = arg1.x;
            y = arg1.y;
        } else {
            id = arg1;
            x = arg2?.x;
            y = arg2?.y;
        }

        console.log('[Service.TopLayer] endDrag called for:', id);
        isDragging = false;
        
        if (widgets.has(id)) {
            const w = widgets.get(id);
            if (x !== undefined && y !== undefined) {
                widgets.set(id, { ...w, x, y });
            }
        }
        
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            console.log('[Service.TopLayer] Restoring shape after drag');
            const rects = [];
            for (const [widgetId, widget] of widgets) {
                const bounds = widget;
                if (bounds.width > 0 && bounds.height > 0) {
                    rects.push({
                        x: Math.round(bounds.x || 0),
                        y: Math.round(bounds.y || 0),
                        width: Math.round(bounds.width),
                        height: Math.round(bounds.height)
                    });
                }
            }
            try {
                if (rects.length === 0) {
                    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
                    overlayWindow.setShape([]);
                } else {
                    overlayWindow.setShape(rects);
                    overlayWindow.setIgnoreMouseEvents(false);
                }
            } catch (e) {
                console.error('[Service.TopLayer] Failed to restore shape after drag', e);
            }
        }
        
        if (pluginApi) {
            pluginApi.emit('widget.drag.end', { id, x, y });
        }
        
        return true;
    },

    stopDrag: () => {
        if (!overlayWindow) return false;
        isDragging = false;
        
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            const rects = [];
            for (const [widgetId, widget] of widgets) {
                const bounds = widget;
                if (bounds.width > 0 && bounds.height > 0) {
                    rects.push({
                        x: Math.round(bounds.x || 0),
                        y: Math.round(bounds.y || 0),
                        width: Math.round(bounds.width),
                        height: Math.round(bounds.height)
                    });
                }
            }
            try {
                if (rects.length === 0) {
                    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
                    overlayWindow.setShape([]);
                } else {
                    overlayWindow.setShape(rects);
                    overlayWindow.setIgnoreMouseEvents(false);
                }
            } catch (e) {
                console.error('[Service.TopLayer] Failed to restore shape after stopDrag', e);
            }
        }
        
        overlayWindow.webContents.send('service.toplayer:stop-drag');
        return true;
    },

    show: () => overlayWindow?.show(),
    hide: () => overlayWindow?.hide(),
    
    showOverlay: (hint) => {
        if (!overlayWindow || overlayWindow.isDestroyed()) return false;
        overlayWindow.webContents.send(CHANNELS.SHOW_OVERLAY, hint);
        return true;
    },
    
    hideOverlay: () => {
        if (!overlayWindow || overlayWindow.isDestroyed()) return false;
        overlayWindow.webContents.send(CHANNELS.HIDE_OVERLAY);
        return true;
    },
    
    // Debug helper
    getWidgetCount: () => widgets.size,
    
    getWidget: (id) => {
        if (!widgets.has(id)) return null;
        const w = widgets.get(id);
        return {
            id: w.id,
            bounds: { x: w.x, y: w.y, width: w.width, height: w.height }
        };
    },

    // Check status
    isRunning: () => !!overlayWindow && !overlayWindow.isDestroyed()
};

function init(api) {
    pluginApi = api;
    // Clean up any existing listeners just in case
    ipcMain.removeListener(CHANNELS.SET_SHAPE, onSetShape);
    ipcMain.on(CHANNELS.SET_SHAPE, onSetShape);
    
    // Handle Drag End
    ipcMain.removeAllListeners(CHANNELS.DRAG_END);
    ipcMain.on(CHANNELS.DRAG_END, (event, payload) => {
        const wasDragging = isDragging;
        isDragging = false;
        
        const { id, x, y } = payload;
        
        if (widgets.has(id)) {
            const w = widgets.get(id);
            widgets.set(id, { ...w, x, y });
            
            if (pluginApi) {
                pluginApi.emit('widget.drag.end', { id, x, y });
            }
        }

        if (wasDragging && overlayWindow && !overlayWindow.isDestroyed()) {
            console.log('[Service.TopLayer] Drag ended, triggering shape update');
            const rects = [];
            for (const [widgetId, widget] of widgets) {
                const bounds = widget;
                if (bounds.width > 0 && bounds.height > 0) {
                    rects.push({
                        x: Math.round(bounds.x || 0),
                        y: Math.round(bounds.y || 0),
                        width: Math.round(bounds.width),
                        height: Math.round(bounds.height)
                    });
                }
            }
            try {
                if (rects.length === 0) {
                    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
                    overlayWindow.setShape([]);
                } else {
                    overlayWindow.setShape(rects);
                    overlayWindow.setIgnoreMouseEvents(false);
                }
            } catch (e) {
                console.error('[Service.TopLayer] Failed to restore shape after drag', e);
            }
        }
    });

    // Handle Drag Move (Real-time)
    ipcMain.removeAllListeners('service.toplayer:drag-move');
    ipcMain.on('service.toplayer:drag-move', (event, payload) => {
        const { id, x, y } = payload;
        if (pluginApi) {
            pluginApi.emit('widget.drag.move', { id, x, y });
        }
    });

    // Handle Overlay Clicked (cancel drag)
    ipcMain.removeAllListeners('service.toplayer:overlay-clicked');
    ipcMain.on('service.toplayer:overlay-clicked', () => {
        console.log('[Service.TopLayer] Overlay clicked, cancelling drag');
        
        // Hide overlay
        functions.hideOverlay();
        
        // Reset drag state
        isDragging = false;
        
        // Restore shape
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            const rects = [];
            for (const [widgetId, widget] of widgets) {
                const bounds = widget;
                if (bounds.width > 0 && bounds.height > 0) {
                    rects.push({
                        x: Math.round(bounds.x || 0),
                        y: Math.round(bounds.y || 0),
                        width: Math.round(bounds.width),
                        height: Math.round(bounds.height)
                    });
                }
            }
            try {
                if (rects.length === 0) {
                    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
                    overlayWindow.setShape([]);
                } else {
                    overlayWindow.setShape(rects);
                    overlayWindow.setIgnoreMouseEvents(false);
                }
            } catch (e) {
                console.error('[Service.TopLayer] Failed to restore shape after overlay click', e);
            }
        }
        
        // Emit cancel event
        if (pluginApi) {
            pluginApi.emit('widget.drag.cancel', {});
        }
    });

    // Handle Renderer Ready
    ipcMain.on('service.toplayer:renderer-ready', () => {
        console.log('[Service.TopLayer] Renderer reported ready');
        isRendererReady = true;
        // Flush pending widgets
        while (pendingWidgets.length > 0) {
            const w = pendingWidgets.shift();
            console.log(`[Service.TopLayer] Flushing pending widget: ${w.id}`);
            if (overlayWindow && !overlayWindow.isDestroyed()) {
                overlayWindow.webContents.send(CHANNELS.ADD, w);
            }
        }
    });

    // Handle heartbeat response from renderer
    ipcMain.on(CHANNELS.HEARTBEAT_RESPONSE, () => {
        handleHeartbeatResponse();
    });

    // Handle display changes
    screen.on('display-added', () => {
        console.log('[Service.TopLayer] Display added, updating bounds');
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            const bounds = getCombinedDisplayBounds();
            overlayWindow.setBounds(bounds);
        }
    });
    
    screen.on('display-removed', () => {
        console.log('[Service.TopLayer] Display removed, updating bounds');
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            const bounds = getCombinedDisplayBounds();
            overlayWindow.setBounds(bounds);
        }
    });
    
    screen.on('display-metrics-changed', () => {
        console.log('[Service.TopLayer] Display metrics changed, updating bounds');
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            const bounds = getCombinedDisplayBounds();
            overlayWindow.setBounds(bounds);
        }
    });

    if (!overlayWindow) {
        createWindow();
    }
    
    if (api && api.splash) {
        api.splash.setStatus('service.toplayer', '初始化置顶层级服务...');
    }
}

// Optional: Called when plugin is disabled/unloaded
function unload() {
    stopTopMostCheck();
    ipcMain.removeListener(CHANNELS.SET_SHAPE, onSetShape);
    
    // Remove display change listeners
    try {
        screen.removeAllListeners('display-added');
        screen.removeAllListeners('display-removed');
        screen.removeAllListeners('display-metrics-changed');
    } catch (e) {}
    
    if (overlayWindow) {
        overlayWindow.destroy();
        overlayWindow = null;
    }
    widgets.clear();
}

module.exports = {
    init,
    unload,
    disabled: unload,
    functions
};
