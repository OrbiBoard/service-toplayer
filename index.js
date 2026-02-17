const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

// Global reference to prevent garbage collection
let overlayWindow = null;
const widgets = new Map();
let isRendererReady = false;
const pendingWidgets = [];

// IPC Channels
const CHANNELS = {
    ADD: 'service.toplayer:add-widget',
    REMOVE: 'service.toplayer:remove-widget',
    UPDATE: 'service.toplayer:update-widget',
    SET_SHAPE: 'service.toplayer:set-window-shape',
    START_DRAG: 'service.toplayer:start-drag',
    DRAG_END: 'service.toplayer:drag-end'
};

// Fix channel names to match renderer (using hyphen instead of dot for consistency if needed, but keeping dot for compatibility with existing calls)
// Actually, let's make sure they match exactly what's in renderer.js
// renderer.js uses 'service.toplayer:...' so we are good.

let pluginApi = null;

/**
 * Handle shape updates from renderer to enable click-through
 */
const onSetShape = (event, payload) => {
    // Security verification
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
        // Special mode: Set shape so Chromium gets Move events, 
        // BUT tell OS to forward clicks (ignoreMouse=true).
        try {
            overlayWindow.setShape(rects);
            overlayWindow.setIgnoreMouseEvents(true, { forward: true });
        } catch (e) {
            console.error('[Service.TopLayer] Failed to set pass-through shape', e);
        }
    } else {
        // Standard mode
        if (!Array.isArray(rects) || rects.length === 0) {
            // No widgets -> full transparency
            overlayWindow.setIgnoreMouseEvents(true, { forward: true });
            // Clear shape? Or set to empty?
            try { overlayWindow.setShape([]); } catch(e) {}
        } else {
            // Widgets present -> Capture mouse in those areas
            try {
                overlayWindow.setShape(rects);
                overlayWindow.setIgnoreMouseEvents(false);
            } catch (e) {
                console.error('[Service.TopLayer] Failed to set shape', e);
            }
        }
    }
};

function createWindow() {
    isRendererReady = false;
    pendingWidgets.length = 0; // Clear pending on new window? Or keep them?
    // If window crashed, we might want to restore widgets.
    // So let's repopulate pendingWidgets from widgets map!
    
    // Repopulate pending from existing widgets map
    for (const [id, opts] of widgets) {
        pendingWidgets.push(opts);
    }
    
    const primaryDisplay = screen.getPrimaryDisplay();
    // Use bounds instead of workArea to cover full screen (including taskbar)
    // Actually, workArea excludes taskbar, bounds includes it.
    // If we want FULL screen overlay, use bounds.
    // But be careful not to block taskbar interaction unless intended.
    // Usually overlays want to be full screen.
    const { x, y, width, height } = primaryDisplay.bounds;

    overlayWindow = new BrowserWindow({
        x, y, width, height,
        type: 'toolbar',        // Helps with staying on top on some OS
        frame: false,           // No window chrome
        transparent: true,      // Transparent background
        resizable: false,
        movable: false,
        alwaysOnTop: true,
        skipTaskbar: true,      // Don't show in taskbar
        hasShadow: false,
        focusable: false,       // Don't steal focus
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false, // Allowed for trusted internal service
            webSecurity: false,
            webviewTag: true,
            backgroundThrottling: false // Keep running when hidden
        }
    });

    // Ensure it stays on top of everything including screensavers/lock screens if possible
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    
    // Explicitly set size to ensure full screen coverage even if DPI scaling is weird
    overlayWindow.setBounds({ x, y, width, height });

    // Initial state: click-through
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });

    overlayWindow.loadFile(path.join(__dirname, 'index.html'));

    overlayWindow.on('closed', () => {
        overlayWindow = null;
        widgets.clear();
        isRendererReady = false;
        pendingWidgets.length = 0;
    });
}

// Public API Functions
const functions = {
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

    startDrag: (id) => {
        if (!overlayWindow || !widgets.has(id)) return false;
        // Temporarily enable mouse events for the whole window to capture drag
        overlayWindow.setIgnoreMouseEvents(false);
        overlayWindow.setShape([{ x: 0, y: 0, width: 99999, height: 99999 }]); // Full screen
        overlayWindow.webContents.send(CHANNELS.START_DRAG, id);
        return true;
    },

    show: () => overlayWindow?.show(),
    hide: () => overlayWindow?.hide(),
    
    // Debug helper
    getWidgetCount: () => widgets.size,
    
    getWidget: (id) => widgets.get(id) || null,

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
        const { id, x, y } = payload;
        if (widgets.has(id)) {
            const w = widgets.get(id);
            widgets.set(id, { ...w, x, y });
            
            // Notify plugin via event
            if (pluginApi) {
                pluginApi.emit('widget.drag.end', { id, x, y });
            }
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

    if (!overlayWindow) {
        createWindow();
    }
    
    if (api && api.splash) {
        api.splash.setStatus('service.toplayer', '初始化置顶层级服务...');
    }
}

// Optional: Called when plugin is disabled/unloaded
function unload() {
    ipcMain.removeListener(CHANNELS.SET_SHAPE, onSetShape);
    if (overlayWindow) {
        overlayWindow.destroy();
        overlayWindow = null;
    }
    widgets.clear();
}

module.exports = {
    init,
    unload, // OrbiBoard might use 'unload' or 'disabled'
    disabled: unload, // Alias for compatibility
    functions
};
