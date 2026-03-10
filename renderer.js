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
    
    // Remove previous listeners
    if (overlayClickCallback) {
        dragOverlay.removeEventListener('click', overlayClickCallback);
    }
    
    // Click callback for mouse - touch is handled by the drag listeners
    overlayClickCallback = (e) => {
        // Cancel the drag - try local listeners first, then notify main process
        if (isDragging && currentDragListeners) {
            currentDragListeners.endDrag();
        } else {
            // For external drag (like sidebar), notify main process to cancel
            ipcRenderer.send('service.toplayer:overlay-clicked');
        }
    };
    
    // Only listen for click (mouse) - touch events are handled by drag listeners
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
    const isTouch = (typeof payload === 'object') ? payload.isTouch : false;
    const lockX = (typeof payload === 'object') ? payload.lockX : false;
    const lockY = (typeof payload === 'object') ? payload.lockY : false;
    
    const widget = widgets.get(id);
    if (!widget) {
        console.log('[Renderer] Widget not found:', id);
        return;
    }

    if (isDragging && currentDragListeners) {
        console.log('[Renderer] Cleaning up previous drag session');
        cleanupDragListeners(currentDragListeners);
        currentDragListeners = null;
    }

    console.log('[Renderer] Setting isDragging = true, isTouch:', isTouch);
    isDragging = true;
    dragWidgetId = id;
    
    if (shapeUpdateTimer) {
        clearTimeout(shapeUpdateTimer);
        shapeUpdateTimer = null;
    }
    
    const initialWidgetX = widget.bounds.x;
    const initialWidgetY = widget.bounds.y;
    const widgetWidth = widget.bounds.width;
    const widgetHeight = widget.bounds.height;

    const clampToBounds = (newX, newY) => {
        const winWidth = window.innerWidth;
        const winHeight = window.innerHeight;
        
        // Ensure widget dimensions are valid
        const w = Math.max(1, widgetWidth);
        const h = Math.max(1, widgetHeight);
        
        // If widget is larger than window, center it
        if (w >= winWidth) {
            newX = Math.round((winWidth - w) / 2);
        } else {
            newX = Math.max(0, Math.min(winWidth - w, newX));
        }
        
        if (h >= winHeight) {
            newY = Math.round((winHeight - h) / 2);
        } else {
            newY = Math.max(0, Math.min(winHeight - h, newY));
        }
        
        return { x: Math.round(newX), y: Math.round(newY) };
    };

    // Show hint near widget for touch mode
    const showTouchHint = () => {
        const hint = document.createElement('div');
        hint.id = 'touch-drag-hint';
        hint.className = 'touch-drag-hint';
        hint.textContent = '请选择拖动目标位置';
        
        // Position hint near the widget, but ensure it stays on screen
        let hintX = initialWidgetX + widgetWidth / 2;
        let hintY = initialWidgetY - 50;
        
        // Ensure hint doesn't go off screen
        const hintWidth = 200; // Approximate width
        const hintHeight = 40; // Approximate height
        
        if (hintX - hintWidth / 2 < 10) hintX = hintWidth / 2 + 10;
        if (hintX + hintWidth / 2 > window.innerWidth - 10) hintX = window.innerWidth - hintWidth / 2 - 10;
        if (hintY < 10) hintY = initialWidgetY + widgetHeight + 50;
        if (hintY + hintHeight > window.innerHeight - 10) hintY = window.innerHeight - hintHeight - 10;
        
        hint.style.left = `${hintX}px`;
        hint.style.top = `${hintY}px`;
        
        document.body.appendChild(hint);
    };

    const hideTouchHint = () => {
        const hint = document.getElementById('touch-drag-hint');
        if (hint) hint.remove();
    };

    // Touch mode: click to select target position
    if (isTouch) {
        const onTargetClick = (e) => {
            // Get click position
            let clientX, clientY;
            if (e.type === 'touchend') {
                if (e.changedTouches && e.changedTouches.length > 0) {
                    clientX = e.changedTouches[0].clientX;
                    clientY = e.changedTouches[0].clientY;
                } else {
                    return;
                }
            } else {
                clientX = e.clientX;
                clientY = e.clientY;
            }
            
            // Calculate new position (center widget on click position)
            let newX = clientX - widgetWidth / 2;
            let newY = clientY - widgetHeight / 2;
            
            const clamped = clampToBounds(newX, newY);
            
            // Update widget position
            updateWidgetBounds(id, { x: clamped.x, y: clamped.y }, true);
            ipcRenderer.send('service.toplayer:drag-move', { id, x: clamped.x, y: clamped.y });
            
            // End drag
            endDrag();
        };

        const endDrag = () => {
            if (!isDragging) return; 
            isDragging = false;
            dragWidgetId = null;
            currentDragListeners = null;
            
            hideTouchHint();
            hideDragOverlay();
            
            dragOverlay.removeEventListener('click', onTargetClick);
            dragOverlay.removeEventListener('touchend', onTargetClick);
            window.removeEventListener('blur', endDrag);
            
            updateWindowShape();
            
            ipcRenderer.send(CHANNELS.DRAG_END, { id, x: widget.bounds.x, y: widget.bounds.y });
        };

        currentDragListeners = { onTargetClick, endDrag };
        
        showDragOverlay('点击屏幕选择目标位置');
        showTouchHint();

        dragOverlay.addEventListener('click', onTargetClick);
        dragOverlay.addEventListener('touchend', onTargetClick);
        window.addEventListener('blur', endDrag);
        
        ipcRenderer.once('service.toplayer:stop-drag', endDrag);
    } 
    // Mouse mode: continuous drag
    else {
        const widgetCenterX = initialWidgetX + widgetWidth / 2;
        const widgetCenterY = initialWidgetY + widgetHeight / 2;
        let pointerOffsetX = null;
        let pointerOffsetY = null;

        const handleMove = (clientX, clientY) => {
            if (pointerOffsetX === null || pointerOffsetY === null) {
                pointerOffsetX = clientX - widgetCenterX;
                pointerOffsetY = clientY - widgetCenterY;
                return;
            }
            
            let newCenterX = clientX - pointerOffsetX;
            let newCenterY = clientY - pointerOffsetY;
            
            let newX = newCenterX - widgetWidth / 2;
            let newY = newCenterY - widgetHeight / 2;
            
            if (lockX) newX = initialWidgetX;
            if (lockY) newY = initialWidgetY;
            
            const clamped = clampToBounds(newX, newY);
            
            updateWidgetBounds(id, { x: clamped.x, y: clamped.y }, true);
            ipcRenderer.send('service.toplayer:drag-move', { id, x: clamped.x, y: clamped.y });
        };

        const onMouseMove = (e) => handleMove(e.clientX, e.clientY);
        
        const endDrag = () => {
            if (!isDragging) return; 
            isDragging = false;
            dragWidgetId = null;
            currentDragListeners = null;
            
            hideDragOverlay();
            
            dragOverlay.removeEventListener('mousemove', onMouseMove);
            dragOverlay.removeEventListener('mouseup', endDrag);
            window.removeEventListener('blur', endDrag);
            
            updateWindowShape();
            
            ipcRenderer.send(CHANNELS.DRAG_END, { id, x: widget.bounds.x, y: widget.bounds.y });
        };

        currentDragListeners = { onMouseMove, endDrag };
        
        showDragOverlay();

        dragOverlay.addEventListener('mousemove', onMouseMove);
        dragOverlay.addEventListener('mouseup', endDrag);
        window.addEventListener('blur', endDrag);
        
        ipcRenderer.once('service.toplayer:stop-drag', endDrag);
    }
});

function cleanupDragListeners(listeners) {
    if (!listeners) return;
    
    dragOverlay.removeEventListener('click', listeners.onTargetClick);
    dragOverlay.removeEventListener('touchend', listeners.onTargetClick);
    dragOverlay.removeEventListener('mousemove', listeners.onMouseMove);
    dragOverlay.removeEventListener('mouseup', listeners.endDrag);
    window.removeEventListener('blur', listeners.endDrag);
    
    // Remove touch hint if exists
    const hint = document.getElementById('touch-drag-hint');
    if (hint) hint.remove();
}

// Overlay control IPC
ipcRenderer.on(CHANNELS.SHOW_OVERLAY, (_, hint) => showDragOverlay(hint));
ipcRenderer.on(CHANNELS.HIDE_OVERLAY, () => hideDragOverlay());

// Handle heartbeat from main process - respond immediately
ipcRenderer.on('service.toplayer:heartbeat', () => {
    ipcRenderer.send('service.toplayer:heartbeat-response');
});

// Notify main process that renderer is ready
ipcRenderer.send('service.toplayer:renderer-ready');
