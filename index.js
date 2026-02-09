const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

let overlayWindow = null;

function init(api) {
    createWindow();

    // Register API functions
    api.functions = {
        toggleCompass: () => {
            if (overlayWindow) {
                overlayWindow.webContents.send('toggle-compass');
            }
        },
        show: () => overlayWindow?.show(),
        hide: () => overlayWindow?.hide()
    };
    
    // Register global event listeners if needed
    // api.on('some-event', () => ...);
}

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    overlayWindow = new BrowserWindow({
        width: width,
        height: height,
        x: 0,
        y: 0,
        type: 'toolbar', // Helps with window management behavior
        transparent: true,
        frame: false,
        resizable: false,
        movable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false, // For easier IPC in this prototype
            webSecurity: false
        }
    });

    // Set to highest level
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    
    // Initialize with empty shape (fully transparent/click-through) until renderer updates
    overlayWindow.setShape([]);

    // Pass through clicks on transparent areas - REPLACED BY setShape
    // overlayWindow.setIgnoreMouseEvents(true, { forward: true });

    // Load the UI
    overlayWindow.loadFile(path.join(__dirname, 'index.html'));

    // Handle set-window-shape from renderer
    ipcMain.on('set-window-shape', (event, rects) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            win.setShape(rects);
        }
    });

    // Handle ignore-mouse-events from renderer - DEPRECATED in favor of setShape
    /*
    ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            win.setIgnoreMouseEvents(ignore, options);
        }
    });
    */
    
    overlayWindow.on('closed', () => {
        overlayWindow = null;
    });
}

function disabled() {
    if (overlayWindow) {
        overlayWindow.close();
    }
}

module.exports = {
    init,
    disabled
};
