# MonoChrome: 1-Bit Remote Browser

MonoChrome is an ultra-low-bandwidth, latency-tolerant remote browser isolation tool. It runs a native Google Chrome instance on a remote Virtual Private Server (VPS) and streams the viewport to your local machine as highly compressed, 1-bit (black and white) PNG frames over WebSockets. 

Perfect for browsing the web on extremely slow, unstable connections, or for securely accessing internal networks without directly exposing your local IP or browser fingerprint.

## Features

* **Ultra-Low Bandwidth:** Uses `sharp` to convert full-color browser frames into 1-bit, high-contrast, black-and-white PNGs, drastically reducing data usage.
* **Extreme Patience Mode:** Custom Socket.io configurations and ACKs ensure the stream stays alive and recovers gracefully, even on heavily throttled or dropping connections.
* **Fully Interactive:** Supports mouse clicks, scrolling, and keyboard typing perfectly mapped to the remote browser.
* **Bidirectional Clipboard:** Seamlessly copy text from the remote VPS browser to your local machine, and paste text (Ctrl+V/Cmd+V) from your local machine into the VPS.
* **Spoofing & Privacy:** Forces custom 1-bit CSS overrides on loaded pages, spoofs WebGL rendering data, and isolates your local machine from trackers.
* **Secure Access:** Built-in HTTP Basic Authentication prevents unauthorized access to your remote browser instance.

## Prerequisites

* Node.js (v18+ recommended)
* Google Chrome Stable installed on the host machine (`google-chrome-stable`)
* Linux/Ubuntu environment with `xvfb` installed (for running Chrome headlessly)

To install xvfb on Ubuntu/Debian:
`sudo apt-get install xvfb`

## Installation

1. Clone the repository and navigate into the directory

2. Install the necessary Node.js dependencies:
   ```bash
   npm install
   ```

3. **IMPORTANT: Update Security Credentials**
   Open `server.js` and change the default Basic Auth credentials before deploying:
   ```javascript
   const USERNAME = 'admin'; // Change this!
   const PASSWORD = 'password'; // Change this!
   ```

## Usage

1. Start the server using xvfb to create a virtual display for Chrome:
   ```bash
   xvfb-run --auto-servernum --server-args="-screen 0 800x600x24" node server.js
   ```
   *(Alternatively, if you are using the included package.json, you can just run `npm start`)*

2. Open your local web browser and navigate to `http://<your-vps-ip>:3000`.
3. Log in using the credentials you set in `server.js`.
4. Enter a URL in the top toolbar and click "Go".

## How It Works

1. **Backend:** Spawns a detached Chrome process with specific flags to disable sandboxing and optimize for headless VPS environments.
2. **Puppeteer:** Connects to Chrome via the remote debugging port (`9222`) to control navigation, inject high-contrast CSS, and intercept clipboard events.
3. **Scraping & Compression:** Puppeteer takes constant screenshots. `sharp` flattens, greyscales, applies a threshold, and compresses the image into a 2-color palette.
4. **Frontend:** Receives base64 image strings via Socket.io, updates the `<img id="browser-view">`, and sends structural input events (clicks, scrolls) back to the server based on image coordinates.

## Troubleshooting

* **Chrome fails to boot:** Ensure `google-chrome-stable` and `xvfb` are installed. If previous instances crashed, you may need to clear zombie processes using `pkill -f google-chrome`.
* **Clipboard not working:** Modern browsers require the page to be served over `HTTPS` or `localhost` to allow `navigator.clipboard.writeText`. If accessing via a remote IP without SSL, clipboard read/write may be blocked by your local browser. Put MonoChrome behind a reverse proxy (like Nginx) with an SSL certificate.

## License

This project is licensed under [Apache-2.0 license](./LICENSE).
