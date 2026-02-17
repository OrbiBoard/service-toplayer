const { ipcRenderer } = require('electron');

// Configuration
const CHANNELS = {
    ADD: 'service.toplayer:add-widget',
    REMOVE: 'service.toplayer:remove-widget',
    UPDATE: 'service.toplayer:update-widget',
    SET_SHAPE: 'service.toplayer:set-window-shape',
    START_DRAG: 'service.toplayer:start-drag',
    DRAG_END: 'service.toplayer:drag-end'
};

// State
const widgets = new Map();
const container = document.getElementById('widget-container');
let shapeUpdateTimer = null;
let isDragging = false; // Flag to prevent shape updates during drag

/**
 * Calculate and send the window shape (clickable areas) to the main process
 */
function updateWindowShape() {
    if (isDragging) return; // Skip during drag
    if (shapeUpdateTimer) clearTimeout(shapeUpdateTimer);

    shapeUpdateTimer = setTimeout(() => {
        // Check if any widget requests pass-through
        let passThroughMode = false;
        for (const [id, widget] of widgets) {
            if (widget.passThrough) passThroughMode = true;
        }

        const rects = [];
        for (const [id, widget] of widgets) {
            const { x, y, width, height } = widget.bounds;
            if (width > 0 && height > 0) {
                rects.push({
                    x: Math.round(x),
                    y: Math.round(y),
                    width: Math.round(width),
                    height: Math.round(height)
                });
            }
        }
        // If no widgets, send empty array to make window fully transparent
        ipcRenderer.send(CHANNELS.SET_SHAPE, { rects, passThroughMode });
        shapeUpdateTimer = null;
    }, 16); // ~60fps debounce
}

/**
 * Create or update a widget element
 */
function renderWidget(options) {
    console.log(`[Service.TopLayer Renderer] Rendering widget: ${options.id}`);
    const { id, url, x, y, width, height, preload, nodeIntegration } = options;

    // Remove existing if any
    if (widgets.has(id)) {
        removeWidget(id);
    }

    // Create wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'widget-wrapper';
    wrapper.id = `widget-${id}`;
    Object.assign(wrapper.style, {
        left: `${x}px`,
        top: `${y}px`,
        width: `${width}px`,
        height: `${height}px`
    });

    // Create webview
    const webview = document.createElement('webview');
    webview.src = url;
    webview.setAttribute('allowtransparency', 'true');
    webview.style.width = '100%';
    webview.style.height = '100%';
    webview.style.background = 'transparent'; // Ensure transparency
    
    // Security & Integration
    const ni = nodeIntegration ? 'true' : 'false';
    const ci = nodeIntegration ? 'false' : 'true'; 
    webview.setAttribute('webpreferences', `contextIsolation=${ci}, nodeIntegration=${ni}, webviewTag=true`);
    
    if (preload) {
        webview.setAttribute('preload', preload);
    }
    
    webview.addEventListener('dom-ready', () => {
        // Maybe send ready signal?
        // Also ensure background is transparent
        webview.insertCSS('html, body { background: transparent !important; }');
    });

    wrapper.appendChild(webview);
    container.appendChild(wrapper);

    // Store state
    widgets.set(id, {
        element: wrapper,
        bounds: { x, y, width, height }
    });

    updateWindowShape();
}

function removeWidget(id) {
    if (widgets.has(id)) {
        const widget = widgets.get(id);
        if (widget.element && widget.element.parentNode) {
            widget.element.parentNode.removeChild(widget.element);
        }
        widgets.delete(id);
        updateWindowShape();
    }
}

function updateWidgetBounds(id, bounds) {
    const widget = widgets.get(id);
    if (!widget) return;

    const { element } = widget;
    const { x, y, width, height } = bounds;

    if (x !== undefined) {
        widget.bounds.x = x;
        element.style.left = `${x}px`;
    }
    if (y !== undefined) {
        widget.bounds.y = y;
        element.style.top = `${y}px`;
    }
    if (width !== undefined) {
        widget.bounds.width = width;
        element.style.width = `${width}px`;
    }
    if (height !== undefined) {
        widget.bounds.height = height;
        element.style.height = `${height}px`;
    }

    // Update bounds in state
    if (width !== undefined) widget.bounds.width = width;
    if (height !== undefined) widget.bounds.height = height;
    if (x !== undefined) widget.bounds.x = x;
    if (y !== undefined) widget.bounds.y = y;

    updateWindowShape();
}

// IPC Listeners
ipcRenderer.on(CHANNELS.ADD, (_, options) => renderWidget(options));
ipcRenderer.on(CHANNELS.REMOVE, (_, id) => removeWidget(id));
ipcRenderer.on(CHANNELS.UPDATE, (_, payload) => updateWidgetBounds(payload.id, payload));

ipcRenderer.on(CHANNELS.START_DRAG, (_, id) => {
    const widget = widgets.get(id);
    if (!widget) return;

    isDragging = true;
    const startX = widget.bounds.x;
    const startY = widget.bounds.y;
    // We don't have mouse event here, so we assume drag starts from current mouse position?
    // Wait, we need the initial mouse position to calculate offset.
    // But START_DRAG is triggered by IPC, which doesn't carry mouse info unless passed.
    // However, if we use screen.getCursorScreenPoint() in main process and pass it down?
    // Or we can just use movementX/Y from mousemove event?
    // But movementX/Y requires pointer lock or continuous events.
    
    // Better approach: 
    // The user clicks on the widget (webview). The webview sends 'mousedown' to plugin main process.
    // Plugin main process calls 'startDrag'.
    // At this point, the mouse is still down.
    // We add 'mousemove' listener to document.
    
    // We need the initial mouse position relative to the widget to keep it under cursor.
    // But we don't have it easily.
    // Let's assume we drag from the center or just use delta.
    
    // Actually, if we use `movementX` and `movementY` from `mousemove` event, we can apply delta.
    // But `movementX` is not always reliable.
    
    // Let's try to get initial mouse position.
    // Since we are in renderer, we can't easily get global mouse pos without an event.
    // But the `mousemove` event will provide `screenX`/`screenY`.
    // The first `mousemove` will give us a position.
    
    let lastScreenX = null;
    let lastScreenY = null;
    
    const onMove = (e) => {
        if (lastScreenX === null) {
            lastScreenX = e.screenX;
            lastScreenY = e.screenY;
            return;
        }
        
        const dx = e.screenX - lastScreenX;
        const dy = e.screenY - lastScreenY;
        
        lastScreenX = e.screenX;
        lastScreenY = e.screenY;
        
        const newX = widget.bounds.x + dx;
        const newY = widget.bounds.y + dy;
        
        updateWidgetBounds(id, { x: newX, y: newY });
    };
    
    const onUp = () => {
        isDragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        
        // Resume shape updates and update final shape
        updateWindowShape();
        
        // Notify main process about drag end and final position
        ipcRenderer.send(CHANNELS.DRAG_END, { id, x: widget.bounds.x, y: widget.bounds.y });
    };
    
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
});

// Notify main process that renderer is ready
ipcRenderer.send('service.toplayer:renderer-ready');
