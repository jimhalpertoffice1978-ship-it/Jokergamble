// Shared constants. Tokens are play money: they cannot be bought, sold or cashed out.
export const CHIPS = [10, 50, 100, 500, 1000];
export const START_BALANCE = 1000;
export const REBUY_AMOUNT = 500; // "Fresh start" when you are out of tokens (host can switch it off)
export const MIN_BET = 10;

// The host (admin) login is static. Set ADMIN_ID and ADMIN_PASSWORD in the environment
// (on Render: Environment tab). The fallback below is only for first-time local runs.
export const DEFAULT_ADMIN_ID = 'admin';
export const DEFAULT_ADMIN_PASSWORD = 'JokerAdmin@2026';
export const ADMIN_ID = (process.env.ADMIN_ID || DEFAULT_ADMIN_ID).trim();
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
