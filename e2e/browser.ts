// The browser every Playwright config launches: Google Chrome by default (a contributor's machine), or the Chromium
// binary named by WEFT_PW_EXECUTABLE where Chrome is not installed (for example a cloud container with
// WEFT_PW_EXECUTABLE=/opt/pw-browsers/chromium). Unset, the configs behave exactly as before.
const executablePath = process.env.WEFT_PW_EXECUTABLE;

export const browserUse = executablePath ? { launchOptions: { executablePath } } : { channel: "chrome" };
