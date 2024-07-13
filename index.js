const util = require('util');
const fs = require('fs');
const pngparse = require('pngparse');
var usb = require('usb');

async function doPrint(deviceVID, devicePID, bufferToBePrinted) {

    // Print the indexed string
    fs.writeFile('output2.bin', bufferToBePrinted, (err) => {
        if (err) throw err;
        console.log('The file has been saved!');
    });

    printLabel(deviceVID, devicePID, bufferToBePrinted)
};


// Function to print a label
function printLabel(deviceVID, devicePID, data) {

    var printer = usb.findByIds(deviceVID, devicePID);

    if (!printer) {
        console.log('Printer not found');
        return;
    }

    printer.open();

    var outputEndpoint = null;
    var interfaceIndex = 0;
    var interfaceClaimed = false;

    try {
        for (var iface of printer.interfaces) {
            iface.claim();
            interfaceClaimed = true;
            for (var endpoint of iface.endpoints) {
                if (endpoint.direction === 'out') {
                    outputEndpoint = endpoint;
                    break;
                }
            }
            if (outputEndpoint) {
                interfaceIndex = iface.interfaceNumber; // store the index for release
                break; // Break out if endpoint found
            }
            iface.release(true); // Release if no endpoint found in this interface
            interfaceClaimed = false;
        }

        // if printer endpoint exist, then transfer the print order to the printer
        if (outputEndpoint) {
            outputEndpoint.transfer(data, function (err) {
                if (err) {
                    console.log('Error sending data:', err);
                } else {
                    console.log('Data sent');
                }
                // Printer connection remains open for further operations
            });
        } else {
            console.log('No valid output endpoint found');
            if (interfaceClaimed) {
                printer.interfaces[interfaceIndex].release(true); // Release interface, but keep printer open
            }
        }
    } catch (error) {
        console.error('An error occurred:', error);
        if (interfaceClaimed) {
            printer.interfaces[interfaceIndex].release(true); // Release interface, but keep printer open
        }
    }
}

function convertToBlackAndWhiteMatrixImage(image, options) {
    // convert image to matrix of pixels:
    let rows = [];

    for (let y = 0; y < image.height; y++) {
        let cols = [];
        for (let x = 0; x < image.width; x++) {
            let pos = x + image.width * y;


            pos = pos * image.channels;
            let pixel = 0; // white = 0, black = 1

            // console.log(image.data[pos], image.data[pos+1], image.data[pos+2], image.data[pos+3]);
            let threshold = options.blackwhiteThreshold;
            let gray;

            // 1 channel : grayscale
            // 2 channels: grayscale + alpha
            // 3 channels: RGB
            // 4 channels: RGBA
            switch (image.channels) {
                case 1:
                    if (image.data[pos] < threshold) pixel = 1;
                    break;

                case 2:
                    gray = image.data[pos] * image.data[pos + 1] / 255;
                    if (gray < threshold) pixel = 1;
                    break;

                case 3:
                    gray = 0.21 * image.data[pos] + 0.72 * image.data[pos + 1] + 0.07 * image.data[pos + 2];
                    if (gray < threshold) pixel = 1;
                    break;

                case 4:
                    gray = (0.21 * image.data[pos] + 0.72 * image.data[pos + 1] + 0.07 * image.data[pos + 2]) * image.data[pos + 3] / 255;
                    if (gray < threshold) pixel = 1;
                    break;
            }

            cols.push(pixel);
        }
        rows.push(cols);
    }

    return {
        height: image.height,
        width: image.width,
        data: rows
    };
}

function rotateMatrixImage(bwMatrixImage) {
    let rows = [];
    for (let x = 0; x < bwMatrixImage.width; x++) {
        let cols = [];
        for (let y = bwMatrixImage.height - 1; y >= 0; y--) {
            cols.push(bwMatrixImage.data[y][x]);
        }
        rows.push(cols);
    }

    // noinspection JSSuspiciousNameCombination
    return {
        height: bwMatrixImage.width,
        width: bwMatrixImage.height,
        data: rows
    };
}

function hexToTwosComplement(hex) {
    // Step 1: Convert the hexadecimal value to a decimal number
    let decimal = parseInt(hex, 16);

    // Step 2: Negate the decimal number
    decimal = -decimal;

    // Step 3: Add one to the negated decimal number
    decimal = decimal + 1;

    // Step 4: Convert the result back to hexadecimal
    // Ensure it is represented as an 8-bit two's complement number
    let result = ((decimal & 0xFF) >>> 0).toString(16).toUpperCase();

    // Handle case when the result is shorter than 2 characters
    if (result.length < 2) {
        result = '0' + result;
    }

    return result;
}

// implements the first 2 steps of the img byte compression used for Brother QL-800 series printers
// as mentioned on pg.33 of https://download.brother.com/welcome/docp100278/cv_ql800_eng_raster_101.pdf
function compressBuffer(buffer) {
    let buffers = []; // Array to hold intermediate buffer results

    let i = 0;
    while (i < buffer.length) {
        let start = i;

        // Count the number of repeated bytes
        while (i + 1 < buffer.length && buffer[i] === buffer[i + 1]) {
            i++;
        }

        let count = i - start + 1;

        if (count > 1) {

            buffers.push(Buffer.from(['0x' + hexToTwosComplement(count.toString(16).padStart(2, '0')), '0x' + buffer[start].toString(16).padStart(2, '0')]));
        } else {
            let unrepeatedBytes = [];

            // Collect unrepeated bytes
            while (i < buffer.length && (i + 1 >= buffer.length || buffer[i] !== buffer[i + 1])) {
                unrepeatedBytes.push(buffer[i]);
                i++;
            }

            // Step back to reprocess the repeated byte in the next iteration
            if (i < buffer.length && buffer[i] === buffer[i + 1]) {
                i--;
            }

            if (unrepeatedBytes.length > 0) {
                let lengthHex = '0x' + (unrepeatedBytes.length - 1).toString(16).padStart(2, '0');
                buffers.push(Buffer.from([lengthHex, ...unrepeatedBytes]));
            }
        }
        i++;
    }

    // Concatenate all parts of the buffer and return
    return Buffer.concat(buffers);
}


function convertImageToDotlabel(bwMatrixImage) {

    // build printer header data for image
    let data = [
        Buffer.alloc(400),                              // invalidate
        Buffer.from([0x1b, 0x40]),                      // initialize
        Buffer.from([0x1b, 0x69, 0x61, 0x01]),          // switch to raster mode
        Buffer.from([0x1b, 0x69, 0x21, 0x00]),          // status notification
        Buffer.from([0x1b, 0x69, 0x7a, 0x86, 0x0a, 0x3e, 0x00, 0xe0, 0x03, 0x00, 0x00, 0x00, 0x00]), // 62mm continuous
        Buffer.from([0x1b, 0x69, 0x4d, 0x40]),          // select auto cut
        Buffer.from([0x1b, 0x69, 0x41, 0x01]),          // auto cut for each sheet
        Buffer.from([0x1b, 0x69, 0x4b, 0x08]),          // select cut at end
        Buffer.from([0x1b, 0x69, 0x64, 0x23, 0x00]),    // 35 dots margin
        Buffer.from([0x4d, 0x02]),                      // disable compression
    ];

    // img byte rasteration and attaching to data buffer to be sent to printer
    // iterate over matrix image
    for (let y = 0; y < bwMatrixImage.height; y++) {

        // each row has 3 bytes for the command and 90 bytes for data
        let rowBuffer = Buffer.alloc(90);

        for (let x = 0; x < bwMatrixImage.width; x++) {
            if (bwMatrixImage.data[y][x] == 1) {
                // calculate current byte and bit
                let byteNum = 93 - Math.floor(x / 8 + 3);
                let bitOffset = x % 8;
                // write data to buffer (which is currently 0x00-initialized)
                rowBuffer[byteNum] |= (1 << bitOffset);
            }
        } /// This for loop implements a method for handling data without compression.
          /// If you want no compress you can just data.push(rowBuffer)


        // comment lines up to and data.push(buf) for no compression
        let buf2 = Buffer.concat([Buffer.from([0x67, 0x00, compressBuffer(rowBuffer).length])]);
        let buf1 = compressBuffer(rowBuffer);
        let buf = Buffer.concat([buf2, buf1]);

        if (buf.equals(Buffer.from([0x67, 0x00, 0x02, 0xa7, 0x00]))) {
            buf = Buffer.from([0x5A]);
        }

        data.push(buf);
        
        // push(rowBuffer); if simply for no compression
    }
    
    data.push(Buffer.from([0x1A]));

    // concat all buffers
    let buf = Buffer.concat(data);
    return buf;
}


async function convert(img, options) {
    // get options
    let defaultOptions = {
        landscape: false,
        blackwhiteThreshold: 128
    };

    // options input check and initializing
    if (options == null) options = defaultOptions;
    if (!options.landscape) options.landscape = defaultOptions.landscape;
    if (!options.blackwhiteThreshold) options.blackwhiteThreshold = defaultOptions.blackwhiteThreshold;

    // By device image width cannot be more than 720 pixels
    // can only store 90 bytes in a row with 8 pixels per byte so that's 720 pixels
    if (!options.landscape) {
        if (img.width > 720) throw new Error('Width cannot be more than 720 pixels');
    } else {
        if (img.height > 720) throw new Error('Height cannot be more than 720 pixels');
    }

    // convert to black and white pixel matrix image (pbm style):
    let bwMatrixImage = convertToBlackAndWhiteMatrixImage(img, options);

    // rotate image if landscape mode is requested
    if (options.landscape) {
        bwMatrixImage = rotateMatrixImage(bwMatrixImage);
    }

    // convert to 'label image' or something that the label printer understands:
    return convertImageToDotlabel(bwMatrixImage);
}



const printerModule = {
    printPngFile: async function (deviceVID, devicePID, filename, options) {
        let parseFile = util.promisify(pngparse.parseFile);
        let img = await parseFile(filename);

        let printData = await convert(img, options);
        return await doPrint(deviceVID, devicePID, printData);
    }
}

module.exports = printerModule