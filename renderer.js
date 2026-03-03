const { ipcRenderer } = require('electron');

// Configuration
const CHANNELS = {
    ADD: 'service.toplayer:add-widget',
    REMOVE: 'service.toplayer:remove-widget',
    UPDATE: 'service.toplayer:update-widget',
    SET_SHAPE: 'service.toplayer:set-window-shape',
    START_DRAG: 'service.toplayer:start-drag',
    DRAG_END: 'service.toplayer:drag-end',
    SHOW_OVERLAY: 'service.toplayer:show-overlay',
    HIDE_OVERLAY: 'service.toplayer:hide-overlay'
};

// State
const widgets = new Map();
const container = document.getElementById('widget-container');
const dragOverlay = document.getElementById('drag-overlay');
let shapeUpdateTimer = null;
let isDragging = false;
let dragWidgetId = null;
let currentDragListeners = null;
let overlayClickCallback = null;

/**
 * Show drag overlay with dim effect
 */
function showDragOverlay(hint = '点击空白区域取消拖动') {
    if (!dragOverlay) return;
    dragOverlay.setAttribute('data-hint', hint);
    dragOverlay.classList.add('active');
    
    // Add click handler to cancel drag
    if (overlayClickCallback) {
        dragOverlay.removeEventListener('click', overlayClickCallback);
    }
    
    overlayClickCallback = (e) => {
        // Cancel the drag - try local listeners first, then notify main process
        if (isDragging && currentDragListeners) {
            currentDragListeners.endDrag();
        } else {
            // For external drag (like sidebar), notify main process to cancel
            ipcRenderer.send('service.toplayer:overlay-clicked');
        }
    };
    
    dragOverlay.addEventListener('click', overlayClickCallback);
}

/**
 * Hide drag overlay
 */
function hideDragOverlay() {
    if (!dragOverlay) return;
    dragOverlay.classList.remove('active');
    
    if (overlayClickCallback) {
        dragOverlay.removeEventListener('click', overlayClickCallback);
        overlayClickCallback = null;
    }
}

/**
 * Calculate and send the window shape (clickable areas) to the main process
 */
function updateWindowShape() {
    console.log('[Renderer] updateWindowShape called, isDragging:', isDragging);
    if (isDragging) {
        console.log('[Renderer] BLOCKED shape update during drag');
        return;
    }
    if (shapeUpdateTimer) clearTimeout(shapeUpdateTimer);

    shapeUpdateTimer = setTimeout(() => {
        if (isDragging) return; // Double check

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

function updateWidgetBounds(id, bounds, skipShapeUpdate = false) {
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

    if (!skipShapeUpdate && !isDragging) {
        updateWindowShape();
    }
}

// IPC Listeners
ipcRenderer.on(CHANNELS.ADD, (_, options) => renderWidget(options));
ipcRenderer.on(CHANNELS.REMOVE, (_, id) => removeWidget(id));
ipcRenderer.on(CHANNELS.UPDATE, (_, payload) => updateWidgetBounds(payload.id, payload));

ipcRenderer.on(CHANNELS.START_DRAG, (_, payload) => {
    console.log('[Renderer] START_DRAG received:', payload);
    const id = (typeof payload === 'string') ? payload : payload.id;
    const initialX = (typeof payload === 'object') ? payload.startX : null;
    const initialY = (typeof payload === 'object') ? payload.startY : null;
    const lockX = (typeof payload === 'object') ? payload.lockX : false;
    const lockY = (typeof payload === 'object') ? payload.lockY : false;
    
    const widget = widgets.get(id);
    if (!widget) {
        console.log('[Renderer] Widget not found:', id);
        return;
    }

    if (isDragging && currentDragListeners) {
        console.log('[Renderer] Cleaning up previous drag session');
        document.removeEventListener('mousemove', currentDragListeners.onMouseMove);
        document.removeEventListener('mouseup', currentDragListeners.endDrag);
        document.removeEventListener('touchmove', currentDragListeners.onTouchMove);
        document.removeEventListener('touchend', currentDragListeners.endDrag);
        document.removeEventListener('touchcancel', currentDragListeners.endDrag);
        window.removeEventListener('blur', currentDragListeners.endDrag);
        currentDragListeners = null;
    }

    console.log('[Renderer] Setting isDragging = true');
    isDragging = true;
    dragWidgetId = id;
    
    if (shapeUpdateTimer) {
        clearTimeout(shapeUpdateTimer);
        shapeUpdateTimer = null;
    }
    
    const startScreenX = initialX;
    const startScreenY = initialY;
    
    const initialWidgetX = widget.bounds.x;
    const initialWidgetY = widget.bounds.y;
    const widgetWidth = widget.bounds.width;
    const widgetHeight = widget.bounds.height;

    const clampToBounds = (newX, newY) => {
        const minX = 0;
        const minY = 0;
        const maxX = window.innerWidth - widgetWidth;
        const maxY = window.innerHeight - widgetHeight;
        
        return {
            x: Math.max(minX, Math.min(maxX, newX)),
            y: Math.max(minY, Math.min(maxY, newY))
        };
    };

    const handleMove = (screenX, screenY) => {
        if (startScreenX === null || startScreenY === null) return;
        
        const totalDx = screenX - startScreenX;
        const totalDy = screenY - startScreenY;
        
        let newX = initialWidgetX;
        let newY = initialWidgetY;

        if (!lockX) newX += totalDx;
        if (!lockY) newY += totalDy;
        
        const clamped = clampToBounds(newX, newY);
        
        updateWidgetBounds(id, { x: clamped.x, y: clamped.y }, true);
        
        ipcRenderer.send('service.toplayer:drag-move', { id, x: clamped.x, y: clamped.y });
    };

    const onMouseMove = (e) => handleMove(e.screenX, e.screenY);
    
    const onTouchMove = (e) => {
        if (e.touches.length === 1) {
            const touch = e.touches[0];
            handleMove(touch.screenX, touch.screenY);
            e.preventDefault();
        }
    };

    const endDrag = () => {
        if (!isDragging) return; 
        isDragging = false;
        dragWidgetId = null;
        currentDragListeners = null;
        
        // Hide overlay
        hideDragOverlay();
        
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', endDrag);
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', endDrag);
        document.removeEventListener('touchcancel', endDrag);
        window.removeEventListener('blur', endDrag);
        
        updateWindowShape();
        
        ipcRenderer.send(CHANNELS.DRAG_END, { id, x: widget.bounds.x, y: widget.bounds.y });
    };

    currentDragListeners = { onMouseMove, endDrag, onTouchMove };
    
    // Show overlay
    showDragOverlay();

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', endDrag);
    document.addEventListener('touchcancel', endDrag);
    window.addEventListener('blur', endDrag);
    
    ipcRenderer.once('service.toplayer:stop-drag', endDrag);
});

// Overlay control IPC
ipcRenderer.on(CHANNELS.SHOW_OVERLAY, (_, hint) => showDragOverlay(hint));
ipcRenderer.on(CHANNELS.HIDE_OVERLAY, () => hideDragOverlay());

// Notify main process that renderer is ready
ipcRenderer.send('service.toplayer:renderer-ready');
