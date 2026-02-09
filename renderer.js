const { ipcRenderer } = require('electron');

const compass = document.getElementById('compass-container');
let isDragging = false;
let startX, startY;
let initialLeft, initialTop;
const DRAG_THRESHOLD = 5;

// --- Window Transparency Management via setShape ---

function updateShape() {
    // If hidden, shape is empty (click through everything)
    if (compass.style.display === 'none') {
        ipcRenderer.send('set-window-shape', []);
        return;
    }

    const rect = compass.getBoundingClientRect();
    // setShape expects integers
    const shape = [{
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
    }];
    ipcRenderer.send('set-window-shape', shape);
}

// Initial shape update
window.addEventListener('DOMContentLoaded', () => {
    // Small delay to ensure layout is stable
    setTimeout(updateShape, 100);
});

// Also update when window resizes (if that were possible) or other events
window.addEventListener('resize', updateShape);

// --- Drag vs Click Logic ---

compass.addEventListener('mousedown', (e) => {
    // Left click only
    if (e.button !== 0) return;

    // IMPORTANT: Set shape to full screen immediately to capture all drag events
    // This ensures that even if mouse moves fast, we don't lose the window
    ipcRenderer.send('set-window-shape', [{
        x: 0, 
        y: 0, 
        width: window.innerWidth, 
        height: window.innerHeight
    }]);

    isDragging = false;
    startX = e.screenX;
    startY = e.screenY;
    
    // Get current position
    const rect = compass.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    // Attach listeners to document to handle drag even if mouse moves fast
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
});

function onMouseMove(e) {
    const dx = e.screenX - startX;
    const dy = e.screenY - startY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (!isDragging && distance > DRAG_THRESHOLD) {
        isDragging = true;
        compass.classList.add('dragging');
    }

    if (isDragging) {
        // Update position
        compass.style.top = (initialTop + dy) + 'px';
        compass.style.left = (initialLeft + dx) + 'px';
        
        // Remove 'right' and 'bottom' if they were set, to rely on top/left
        compass.style.right = 'auto';
        compass.style.bottom = 'auto';
        
        // Note: We do NOT update shape during drag, because we are in full-screen shape mode.
        // This is much more performant than constantly calling setShape.
    }
}

function onMouseUp(e) {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    if (isDragging) {
        // Drag finished
        isDragging = false;
        compass.classList.remove('dragging');
        
        // Restore shape to just the compass component
        updateShape();
        
    } else {
        // It was a click
        handleCompassClick();
        // Even after a click, we must restore the shape (because mousedown set it to full screen)
        updateShape();
    }
}

function handleCompassClick() {
    console.log('Compass clicked!');
    // Example action: rotate
    const btn = compass.querySelector('.compass-btn');
    const currentRot = btn.style.transform.replace(/[^\d.]/g, '') || 0;
    // Just rotate 90 deg visually for demo
    // Note: We are not actually rotating the div, just changing text/style
    // If we rotated the div, getBoundingClientRect would change, which is fine for setShape
    
    btn.innerHTML = (btn.innerHTML === 'N') ? 'E' : 
                    (btn.innerHTML === 'E') ? 'S' : 
                    (btn.innerHTML === 'S') ? 'W' : 'N';
}

// Listen for toggle command from main process
ipcRenderer.on('toggle-compass', () => {
    if (compass.style.display === 'none') {
        compass.style.display = 'block';
    } else {
        compass.style.display = 'none';
    }
    // Update shape based on new visibility
    updateShape();
});
