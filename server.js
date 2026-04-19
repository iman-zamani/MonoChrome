const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');
const puppeteer = require('puppeteer');
const sharp = require('sharp');

const app = express();
const server = http.createServer(app);

// --- EXTREME PATIENCE SETTINGS ---
const io = new Server(server, {
    pingTimeout: 120000,   
    pingInterval: 25000,   
    maxHttpBufferSize: 1e8 
});

// --- SECURITY SETTINGS ---
const USERNAME = 'admin';
const PASSWORD = 'password'; 

app.use((req, res, next) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login && password && login === USERNAME && password === PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="VPS Browser"');
    res.status(401).send('Authentication required.');
});

app.get('/', (req, res) => {
    let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    html = html.replace('__SOCKET_PASSWORD__', PASSWORD);
    res.send(html);
});

io.use((socket, next) => {
    if (socket.handshake.auth.password === PASSWORD) next();
    else next(new Error("Unauthorized"));
});

// --- STATE MANAGEMENT & LOCKS ---
let browser;
let page;
let currentUrl = 'https://news.ycombinator.com';
let lastScrapedData = ""; 
let frameQueue = [];
let isWaitingForAck = false;
let currentSocket = null;

let isNavigating = false;
let isScraping = false;

async function startBrowser() {
    console.log('Spawning native Chrome process...');
    
    const chromeProcess = spawn('google-chrome-stable', [
        '--remote-debugging-port=9222',
        '--no-first-run',
        '--no-default-browser-check',
        '--user-data-dir=' + path.join(__dirname, 'chrome-profile'),
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', 
        '--disable-features=site-per-process', 
        '--disable-gpu',
        '--window-size=800,600'
    ], { 
        detached: true, 
        stdio: 'ignore',
        env: process.env 
    });

    chromeProcess.unref();

    console.log('Patiently waiting for Chrome to boot (polling port 9222)...');
    
    let wsUrl = null;
    let attempts = 0;
    while (attempts < 20) {
        try {
            const response = await axios.get('http://127.0.0.1:9222/json/version');
            wsUrl = response.data.webSocketDebuggerUrl;
            console.log(`Back door connected successfully on attempt ${attempts + 1}.`);
            break;
        } catch (err) {
            attempts++;
            await new Promise(r => setTimeout(r, 1000)); 
        }
    }

    if (!wsUrl) {
        console.error('Fatal Error: Chrome never opened port 9222. Run: pkill -f google-chrome');
        process.exit(1);
    }

    browser = await puppeteer.connect({
        browserWSEndpoint: wsUrl,
        defaultViewport: null
    });
    
    await setupNewPage();
    await navigate(currentUrl);

    setInterval(scrapePage, 5000);
}

async function setupNewPage() {
    console.log("Configuring browser tab...");
    
    const pages = await browser.pages();
    page = pages[0]; 

    if (!page) {
        page = await browser.newPage();
    }
    
    page.setDefaultNavigationTimeout(120000); 
    await page.setViewport({ width: 800, height: 600 });

    // --- NEW: Expose function for the clipboard bridge ---
    try {
        await page.exposeFunction('sendClipboardToNode', (text) => {
            if (currentSocket) {
                currentSocket.emit('vps_copied', text);
            }
        });
    } catch (e) {
        // Ignore if already exposed during a crash recovery
    }

    await page.evaluateOnNewDocument(() => {
        // WebGL Spoofing
        const getParameter = WebGLRenderingContext.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) return 'Intel Inc.';
            if (parameter === 37446) return 'Intel Iris OpenGL Engine';
            return getParameter(parameter);
        };

        // --- NEW: Intercept VPS Copy Events ---
        document.addEventListener('copy', () => {
            const selection = document.getSelection().toString();
            if (selection) window.sendClipboardToNode(selection);
        });

        const originalWriteText = navigator.clipboard ? navigator.clipboard.writeText : null;
        if (originalWriteText) {
            navigator.clipboard.writeText = async function(text) {
                window.sendClipboardToNode(text);
                return originalWriteText.apply(navigator.clipboard, arguments);
            };
        }

        // High-Contrast 1-Bit styling
        const style = document.createElement('style');
        style.textContent = `
            * {
                color: #000000 !important; 
                font-weight: 700 !important; 
                -webkit-text-stroke: 0.8px black !important; 
                text-shadow: 0px 0px 1px #000 !important; 
            }
            body, html { background-color: #ffffff !important; }
            input, textarea { border: 2px solid black !important; background: white !important; color: black !important; }
            img, video, canvas, svg { filter: contrast(150%) grayscale(100%) brightness(80%) !important; }
        `;
        document.documentElement.appendChild(style);
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    console.log("Tab configuration complete.");
}

async function navigate(url) {
    if (isNavigating) return; 
    isNavigating = true;
    
    console.log(`Navigating VPS to: ${url}`);
    
    frameQueue = [];
    lastScrapedData = ""; 
    
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        currentUrl = await page.url();
        scrapePage(); 
    } catch (err) {
        console.error("Navigation failed:", err.message);
        if (err.message.includes('Not attached') || err.message.includes('closed')) {
            await setupNewPage(); 
        }
    } finally {
        isNavigating = false;
    }
}

async function scrapePage() {
    if (!page || isScraping || isNavigating || page.isClosed()) return;
    
    isScraping = true;
    try {
        const rawBuffer = await page.screenshot({ type: 'png' });

        const processedBuffer = await sharp(rawBuffer)
            .flatten({ background: '#ffffff' })
            .greyscale()                        
            .threshold(200)                     
            .png({ palette: true, colors: 2, compressionLevel: 9 }) 
            .toBuffer();

        const frameData = processedBuffer.toString('base64');

        if (frameData !== lastScrapedData) {
            frameQueue.push(frameData);
            lastScrapedData = frameData;
            if (frameQueue.length > 20) frameQueue.shift(); 
            processQueue();
        }
    } catch (err) {
        console.error("Scraping error:", err.message);
        if (err.message.includes('Not attached') || err.message.includes('closed')) {
            console.log("Tab crashed! Initiating auto-recovery...");
            await setupNewPage();
            await navigate(currentUrl);
        }
    } finally {
        isScraping = false;
    }
}

function processQueue() {
    if (isWaitingForAck || frameQueue.length === 0 || !currentSocket) return;

    isWaitingForAck = true;
    const payload = frameQueue[frameQueue.length - 1];
    frameQueue = []; 

    currentSocket.emit('frame_update', payload, (ackReceived) => {
        if (ackReceived) {
            isWaitingForAck = false; 
            processQueue(); 
        }
    });
}

io.on('connection', (socket) => {
    currentSocket = socket;
    isWaitingForAck = false; 
    processQueue();

    socket.on('navigate', (url) => navigate(url));

    socket.on('click', async ({ x, y }) => {
        if (!page || isNavigating) return;
        try {
            await page.mouse.click(x, y);
            setTimeout(scrapePage, 100); 
        } catch (err) {}
    });

    socket.on('scroll', async ({ deltaY }) => {
        if (!page || isNavigating) return;
        try {
            await page.mouse.wheel({ deltaY });
            setTimeout(scrapePage, 100); 
        } catch (err) {}
    });

    socket.on('keypress', async ({ key }) => {
        if (!page || isNavigating) return;
        try {
            await page.keyboard.press(key);
            setTimeout(scrapePage, 50); 
        } catch (err) {}
    });

    // --- NEW: Paste text directly into the VPS ---
    socket.on('paste', async (text) => {
        if (!page || isNavigating) return;
        try {
            await page.keyboard.type(text); 
            setTimeout(scrapePage, 100); 
        } catch (err) {}
    });

    socket.on('disconnect', () => {
        if (currentSocket === socket) currentSocket = null;
    });
});

// STARTUP SEQUENCE
startBrowser().then(() => {
    server.listen(3000, () => {
        console.log('--------------------------------------------------');
        console.log('VPS Browser running securely at http://localhost:3000');
        console.log('--------------------------------------------------');
    });
});

// CLEANUP: Kill Chrome if Node crashes
process.on('exit', () => {
    try { require('child_process').execSync('pkill -f google-chrome'); } catch(e) {}
});
process.on('SIGINT', () => { process.exit(); });

give me a good name for this project and give me a proper readme for it as well 
