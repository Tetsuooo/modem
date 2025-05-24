console.log("Modem JS loaded");

import * as PIXI from 'pixi.js';
window.PIXI = PIXI; // Expose PIXI globally
import 'pixi-apngandgif'; // Import the plugin so it registers its loader
