const {createReadStream} = require('fs');
const {join} = require('path');

const {PNG} = require('pngjs');
const {skip, test} = require('tap');

const VideoSensing = require('../../src/extensions/scratch3_video_sensing/index.js');
const VideoMotion = require('../../src/extensions/scratch3_video_sensing/library.js');

/**
 * Prefix to the mock frame images used to test the video sensing extension.
 * @type {string}
 */
const pngPrefix = 'extension_video_sensing_';

/**
 * Map of frame keys to the image filenames appended to the pngPrefix.
 * @type {object}
 */
const framesMap = {
    center: 'center',
    left: 'left-5',
    left2: 'left-10',
    down: 'down-10'
};

/**
 * Asynchronously read a png file and copy its pixel data into a typed array
 * VideoMotion will accept.
 * @param {string} name - partial filename to read
 * @returns {Promise.<Uint32Array>} pixel data of the image
 */
const readPNG = name => (
    new Promise((resolve, reject) => {
        const png = new PNG();
        createReadStream(join(__dirname, `${pngPrefix}${name}.png`))
            .pipe(png)
            .on('parsed', () => {
                // Copy the RGBA pixel values into a separate typed array and
                // cast the array to Uint32, the array format VideoMotion takes.
                resolve(new Uint32Array(new Uint8ClampedArray(png.data).buffer));
            })
            .on('error', reject);
    })
);

/**
 * Read all the frames for testing asynchrnously and produce an object with
 * keys following the keys in framesMap.
 * @returns {object} mapping of keys in framesMap to image data read from disk
 */
const readFrames = (() => {
    // Use this immediately invoking function expression (IIFE) to delay reading
    // once to the first test that calls readFrames.
    let _promise = null;

    return () => {
        if (_promise === null) {
            _promise = Promise.all(Object.keys(framesMap).map(key => readPNG(framesMap[key])))
                .then(pngs => (
                    Object.keys(framesMap).reduce((frames, key, i) => {
                        frames[key] = pngs[i];
                        return frames;
                    }, {})
                ));
        }
        return _promise;
    };
})();

(process.env.npm_package_name ? skip : test)('benchmark', t => {
    t.plan(1);

    return readFrames()
        .then(frames => {
            const detect = new VideoMotion();

            // eslint-disable-next-line global-require
            const Benchmark = require('benchmark');
            const suite = new Benchmark.Suite();

            return new Promise((resolve, reject) => {
                // add tests
                suite
                    .add('VideoMotion#analyzeFrame', () => {
                        detect.addFrame(frames.center);
                        detect.addFrame(frames.left);

                        detect.analyzeFrame();
                    })
                    // add listeners
                    .on('cycle', event => {
                        t.comment(String(event.target));
                    })
                    .on('error', reject)
                    .on('complete', resolve)
                    // run async
                    .run({
                        async: true,
                        maxTime: 0.1
                    });
            });
        })
        .then(() => {
            t.pass('benchmark complete');
            t.end();
        });
});
