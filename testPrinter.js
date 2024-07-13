const brother = require("node-brother-label-printer");
const VID = 0x04f9;
const PID = 0x209d;

brother.printPngFile(VID, PID, "./sample-image.png", { landscape: false });