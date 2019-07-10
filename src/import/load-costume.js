const regeneratorRuntime = require('regenerator-runtime');

const StringUtil = require('../util/string-util');
const log = require('../util/log');

const LoadTask = require('./load-task');
const loadAspect = require('./load-aspect');

const loadCostumeHasTextLayer = function ({

}) {
    return function (scope, options) {
        return Boolean(scope.costume.textLayerMD5);
    };
};

const loadCostumeHasWrongScale = function ({

}) {
    return function (scope, options) {
        return scope.costume.bitmapResolution === 1;
    };
};

const loadCostumeUpgrades = function (config) {
    const {
        hasTextLayer = loadCostumeHasTextLayer(config),
        hasWrongScale = loadCostumeHasWrongScale(config)
    } = config;
    return function (scope, options) {
        return hasTextLayer(scope, options) || hasWrongScale(scope, options);
    };
};

const loadBitmapFromAsset = function ({
    field = 'asset',
    elementField = 'baseImageElement'
}) {
    return function (scope, options) {
        const asset = scope.costume[field];

        if (typeof createImageBitmap !== 'undefined') {
            return createImageBitmap(
                new Blob([asset.data], {type: asset.assetType.contentType})
            ).then(bitmap => {
                scope[elementField] = bitmap;
            });
        }

        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = function () {
                resolve(image);
                image.onload = null;
                image.onerror = null;
            };
            image.onerror = function () {
                reject('Costume load failed. Asset could not be read.');
                image.onload = null;
                image.onerror = null;
            };
            image.src = asset.encodeDataURI();
        }).then(element => {
            scope[elementField] = element;
        });
    };
};

const loadCostumeInDerived = function ({
}) {
    return function (scope, {runtime}) {
        if (runtime.derived) {
            // console.log(scope.costume.assetId, runtime.derived[scope.costume.assetId]);
            return Boolean(runtime.derived[scope.costume.assetId]);
        }
        return false;
    }
};

const loadCostumeInAtlas = function ({
    field = 'asset'
}) {
    return function (scope, {runtime}) {
        console.log('atlas?', !!runtime.atlas);
        if (runtime.atlas) {
            const tile = runtime.atlas.findTile(scope.costume.assetId);
            console.log(scope.costume.assetId, tile);
            return Boolean(tile);
        }
        return false;
    };
};

const loadAtlasMapFromBulk = function ({
}) {
    return function (scope, {runtime}) {
        if (runtime.bulk) {
            const asset = runtime.bulk.find(scope.assetId);
            if (asset) {
                return Promise.resolve(asset)
                .then(asset => {
                    scope.asset = runtime.storage.createAsset(
                        runtime.storage.AssetType.ImageBitmap,
                        runtime.storage.DataFormat.PNG,
                        asset.data,
                        scope.assetId
                    );
                });
            }
        }
    }
};

const loadAtlasMapAsset = function ({
}) {
    return function (scope, {runtime}) {
        if (!scope.asset) {
            const assetType = runtime.storage.AssetType.ImageBitmap;
            const md5 = scope.assetId;
            const dataFormat = scope.dataFormat;
            return runtime.storage.load(assetType, md5, dataFormat)
            .then(asset => {
                scope.asset = asset;
            });
        }
    };
};

const loadAtlasMapCanvas = function ({
    field = 'asset',
    loadAsset = loadAtlasMapAset({})
}) {
    return function (scope, {runtime}) {
        if (runtime.atlas) {
            const tile = runtime.atlas.findTile(scope.costume.assetId);
            if (tile) {
                if (!tile.map.asset.promise) {
                    tile.map.asset.loadCanvas(Promise.resolve()
                        .then(() => {
                            const subscope = {
                                assetId: tile.map.asset.assetId,
                                dataFormat: tile.map.asset.dataFormat,
                                asset: null
                            };
                            console.log(subscope);
                            return loadAsset.run(subscope, {runtime})
                            .then(() => (console.log(subscope), subscope.asset));
                        })
                        .then(asset => (
                            console.log(asset),
                            createImageBitmap(
                                new Blob([asset.data], {type: asset.assetType.contentType})
                            )
                        ))
                        .then(bitmap => {
                            const canvas = document.createElement('canvas');
                            canvas.width = bitmap.width;
                            canvas.height = bitmap.height;
                            canvas.getContext('2d').drawImage(bitmap, 0, 0);
                            return canvas;
                        })
                    );
                }
            }
        }
    };
};

const loadBitmapFromAtlas = function ({
    field = 'asset',
    elementField = 'baseImageElement'
}) {
    return function (scope, {runtime}) {
        if (runtime.atlas) {
            const tile = runtime.atlas.findTile(scope.costume.assetId);
            if (tile) {
                return tile.map.asset.loadCanvas().then(mapAsset => {
                    let _bytes;
                    scope.costume.asset = {
                        assetType: runtime.storage.AssetType.ImageBitmap,
                        assetId: tile.asset.assetId,
                        dataFormat: 'png',
                        get data () {
                            if (!_bytes) {
                                console.log('bytes for');
                                const canvas = document.createElement('canvas');
                                canvas.width = tile.tile.width;
                                canvas.height = tile.tile.height;
                                canvas.getContext('2d').drawImage(mapAsset.canvas, tile.tile.left, tile.tile.top, tile.tile.width, tile.tile.height, 0, 0, tile.tile.width, tile.tile.height);
                                const dataURL = canvas.toDataURL();
                                const codes = btoa(dataURL.substring(dataURL.indexOf(',')));
                                _bytes = new Uint8Array(codes.length);
                                for (let i = 0; i < _bytes.length; i++) {
                                    _bytes[i] = codes.charCodeAt(i);
                                }
                                console.log(_bytes.length);
                            }
                            return _bytes;
                        }
                    };
                    scope.canvas = tile.getImageData(mapAsset);
                });
            }
        }
    };
};

const loadBitmapCanvas = function ({
    elementField = 'baseImageElement'
}) {
    return function (scope, {costume}) {
        const imageElement = scope[elementField];

        const mergeCanvas = scope.mergeCanvas = scope.canvas = canvasPool.create();

        mergeCanvas.width = imageElement.width;
        mergeCanvas.height = imageElement.height;

        const ctx = mergeCanvas.getContext('2d');
        ctx.drawImage(imageElement, 0, 0);
    };
};

const loadBitmapUpgradeTextLayer = function ({

}) {
    return function (scope, {costume}) {
        const {
            mergeCanvas,
            textImageElement
        } = scope;

        const ctx = mergeCanvas.getContext('2d');
        if (textImageElement) {
            ctx.drawImage(textImageElement, 0, 0);
        }

        // Clean up the costume object
        delete costume.textLayerAsset;
        delete costume.textLayerID;
        delete costume.textLayerMD5;
    };
};

const loadBitmapUpgradeScale = function ({

}) {
    return function (scope, {runtime}) {
        // Track the canvas we merged the bitmaps onto separately from the
        // canvas that we receive from resize if scale is not 1. We know
        // resize treats mergeCanvas as read only data. We don't know when
        // resize may use or modify the canvas. So we'll only release the
        // mergeCanvas back into the canvas pool. Reusing the canvas from
        // resize may cause errors.
        const {costume, rotationCenter} = scope;
        const scale = costume.bitmapResolution === 1 ? 2 : 1;
        if (scale !== 1) {
            const {mergeCanvas} = scope;
            scope.canvas = runtime.v2BitmapAdapter.resize(mergeCanvas, mergeCanvas.width * scale, mergeCanvas.height * scale);
        }

        // By scaling, we've converted it to bitmap resolution 2
        costume.bitmapResolution = 2;
        if (rotationCenter) {
            rotationCenter[0] = rotationCenter[0] * scale;
            rotationCenter[1] = rotationCenter[1] * scale;
            costume.rotationCenterX = rotationCenter[0];
            costume.rotationCenterY = rotationCenter[1];
        }
    };
};

const loadBitmapUpgradeAsset = function ({

}) {
    return function (scope, {runtime: {storage, v2BitmapAdapter}}) {
        const dataURI = scope.canvas.toDataURL();
        scope.costume.asset = {
            assetType: storage.AssetType.ImageBitmap,
            dataFormat: storage.DataFormat.PNG,
            data: v2BitmapAdapter.convertDataURIToBinary(dataURI)
        };
    };
};

const loadBitmapRender = function ({

}) {
    return function ({costume, canvas, rotationCenter}, {runtime: {renderer}}) {
        // createBitmapSkin does the right thing if costume.bitmapResolution or
        // rotationCenter are undefined...
        costume.skinId = renderer.createBitmapSkin(canvas, costume.bitmapResolution, rotationCenter);

        let imageData = canvas;
        if (imageData instanceof HTMLCanvasElement) {
            imageData = canvas.getContext('2d').getImageData(0, 0, imageData.width, imageData.height);
        }
        if (imageData instanceof ImageData) {
            costume.asset._imageData = imageData;
        } else {
            console.error('Cannot determine image data from bitmap asset');
        }
    };
};

const loadCostumeUpdateSkinRotationCenter = function ({

}) {
    return function ({costume, rotationCenter}, {runtime: {renderer}}) {
        costume.size = renderer.getSkinSize(costume.skinId);
        if (!rotationCenter) {
            rotationCenter = renderer.getSkinRotationCenter(costume.skinId);
            costume.rotationCenterX = rotationCenter[0];
            costume.rotationCenterY = rotationCenter[1];
        }
    };
};

const loadCostumeScaleSkinRotationCenter = function ({
    scale = 2
}) {
    return function ({costume, rotationCenter}, {}) {
        costume.size = [costume.size[0] * scale, costume.size[1] * scale];
        if (!rotationCenter) {
            costume.rotationCenterX = costume.rotationCenterX * scale;
            costume.rotationCenterY = costume.rotationCenterY * scale;
            costume.bitmapResolution = scale;
        }
    };
};

const loadBitmapCanvasCleanup = function ({

}) {
    return function (scope, options) {
        canvasPool.release(scope.mergeCanvas);
    };
};

const loadVector_ = function (costume, runtime, rotationCenter, optVersion) {
    return new Promise(resolve => {
        let svgString = costume.asset.decodeText();
        // SVG Renderer load fixes "quirks" associated with Scratch 2 projects
        if (optVersion && optVersion === 2 && !runtime.v2SvgAdapter) {
            log.error('No V2 SVG adapter present; SVGs may not render correctly.');
        } else if (optVersion && optVersion === 2 && runtime.v2SvgAdapter) {
            runtime.v2SvgAdapter.loadString(svgString, true /* fromVersion2 */);
            svgString = runtime.v2SvgAdapter.toString();
            // Put back into storage
            const storage = runtime.storage;
            costume.asset.encodeTextData(svgString, storage.DataFormat.SVG, true);
            costume.assetId = costume.asset.assetId;
            costume.md5 = `${costume.assetId}.${costume.dataFormat}`;
        }

        if (costume.derivedAsset && costume.derivedAsset.data) {
            const jsonText = costume.derivedAsset.decodeText();
            svgString = JSON.parse(jsonText);
            costume.derivedAsset.parsed = svgString;
        } else {
            runtime.v2SvgAdapter.loadString(svgString);
            runtime.v2SvgAdapter.toJson().then(json => {
                // const walk = (node, index, parent) => {
                //     if (Array.isArray(node)) {
                //         if (node[0] === 'Raster') {
                //             const url = node[1].buffer;
                //             const content = url.split(/^[^,]+,/)[1];
                //             const utfBytes = atob(content);
                //             const bytes = new Uint8Array(utfBytes.length);
                //
                //             for (let i = 0; i < bytes.length; i++) {
                //                 bytes[i] = utfBytes.charCodeAt(i);
                //             }
                //
                //             costume.asset.rasterAssets = costume.asset.rasterAssets || [];
                //             costume.asset.rasterAssets.push(runtime.storage.createAsset(
                //                 runtime.storage.AssetType.ImageBitmap,
                //                 runtime.storage.DataFormat.PNG,
                //                 bytes, null, true));
                //
                //             console.log(node);
                //             // parent[Object.keys(parent)[index]] = ["Raster", node[1].name];
                //         } else {
                //             node.forEach(walk);
                //         }
                //     } else if (node && typeof node === 'object') {
                //         Object.values(node).forEach(walk);
                //     }
                // };
                // walk(json);

                const data = JSON.stringify(json);
                costume.derivedAsset = runtime.storage.createAsset({
                    contentType: 'application/json',
                    name: 'ImagePaper',
                    runtimeFormat: runtime.storage.DataFormat.JSON,
                    immutable: true
                }, runtime.storage.DataFormat.JSON, null, null, false);
                costume.derivedAsset.encodeTextData(data, runtime.storage.DataFormat.JSON, true);
            });
        }

        // createSVGSkin does the right thing if rotationCenter isn't provided, so it's okay if it's
        // undefined here
        costume.skinId = runtime.renderer.createSVGSkin(svgString, rotationCenter);
        costume.size = runtime.renderer.getSkinSize(costume.skinId);
        // Now we should have a rotationCenter even if we didn't before
        if (!rotationCenter) {
            rotationCenter = runtime.renderer.getSkinRotationCenter(costume.skinId);
            costume.rotationCenterX = rotationCenter[0];
            costume.rotationCenterY = rotationCenter[1];
            costume.bitmapResolution = 1;
        }

        resolve(costume);
    });
};

const canvasPool = (function () {
    /**
     * A pool of canvas objects that can be reused to reduce memory
     * allocations. And time spent in those allocations and the later garbage
     * collection.
     */
    class CanvasPool {
        constructor () {
            this.pool = [];
            this.clearSoon = null;
        }

        /**
         * After a short wait period clear the pool to let the VM collect
         * garbage.
         */
        clear () {
            if (!this.clearSoon) {
                this.clearSoon = new Promise(resolve => setTimeout(resolve, 1000))
                    .then(() => {
                        this.pool.length = 0;
                        this.clearSoon = null;
                    });
            }
        }

        /**
         * Return a canvas. Create the canvas if the pool is empty.
         * @returns {HTMLCanvasElement} A canvas element.
         */
        create () {
            return this.pool.pop() || document.createElement('canvas');
        }

        /**
         * Release the canvas to be reused.
         * @param {HTMLCanvasElement} canvas A canvas element.
         */
        release (canvas) {
            this.clear();
            this.pool.push(canvas);
        }
    }

    return new CanvasPool();
}());

/**
 * Return a promise to fetch a bitmap from storage and return it as a canvas
 * If the costume has bitmapResolution 1, it will be converted to bitmapResolution 2 here (the standard for Scratch 3)
 * If the costume has a text layer asset, which is a text part from Scratch 1.4, then this function
 * will merge the two image assets. See the issue LLK/scratch-vm#672 for more information.
 * @param {!object} costume - the Scratch costume object.
 * @param {!Runtime} runtime - Scratch runtime, used to access the v2BitmapAdapter
 * @param {?object} rotationCenter - optionally passed in coordinates for the center of rotation for the image. If
 *     none is given, the rotation center of the costume will be set to the middle of the costume later on.
 * @property {number} costume.bitmapResolution - the resolution scale for a bitmap costume.
 * @returns {?Promise} - a promise which will resolve to an object {canvas, rotationCenter, assetMatchesBase},
 *     or reject on error.
 *     assetMatchesBase is true if the asset matches the base layer; false if it required adjustment
 */
const fetchBitmapCanvas_ = function (costume, runtime, rotationCenter) {
    if (!costume || !costume.asset) {
        return Promise.reject('Costume load failed. Assets were missing.');
    }
    if (!runtime.v2BitmapAdapter) {
        return Promise.reject('No V2 Bitmap adapter present.');
    }

    return Promise.all([costume.asset, costume.textLayerAsset].map(asset => {
        if (!asset) {
            return null;
        }

        if (typeof createImageBitmap !== 'undefined') {
            return createImageBitmap(
                new Blob([asset.data], {type: asset.assetType.contentType})
            );
        }

        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = function () {
                resolve(image);
                image.onload = null;
                image.onerror = null;
            };
            image.onerror = function () {
                reject('Costume load failed. Asset could not be read.');
                image.onload = null;
                image.onerror = null;
            };
            image.src = asset.encodeDataURI();
        });
    }))
        .then(([baseImageElement, textImageElement]) => {
            const mergeCanvas = canvasPool.create();

            const scale = costume.bitmapResolution === 1 ? 2 : 1;
            mergeCanvas.width = baseImageElement.width;
            mergeCanvas.height = baseImageElement.height;

            const ctx = mergeCanvas.getContext('2d');
            ctx.drawImage(baseImageElement, 0, 0);
            if (textImageElement) {
                ctx.drawImage(textImageElement, 0, 0);
            }
            // Track the canvas we merged the bitmaps onto separately from the
            // canvas that we receive from resize if scale is not 1. We know
            // resize treats mergeCanvas as read only data. We don't know when
            // resize may use or modify the canvas. So we'll only release the
            // mergeCanvas back into the canvas pool. Reusing the canvas from
            // resize may cause errors.
            let canvas = mergeCanvas;
            if (scale !== 1) {
                canvas = runtime.v2BitmapAdapter.resize(mergeCanvas, canvas.width * scale, canvas.height * scale);
            }

            // By scaling, we've converted it to bitmap resolution 2
            if (rotationCenter) {
                rotationCenter[0] = rotationCenter[0] * scale;
                rotationCenter[1] = rotationCenter[1] * scale;
                costume.rotationCenterX = rotationCenter[0];
                costume.rotationCenterY = rotationCenter[1];
            }
            costume.bitmapResolution = 2;

            // Clean up the costume object
            delete costume.textLayerMD5;
            delete costume.textLayerAsset;

            return {
                canvas,
                mergeCanvas,
                rotationCenter,
                // True if the asset matches the base layer; false if it required adjustment
                assetMatchesBase: scale === 1 && !textImageElement
            };
        })
        .catch(() => {
            // Clean up the text layer properties if it fails to load
            delete costume.textLayerMD5;
            delete costume.textLayerAsset;
        });
};

// const loadBitmap_ = function (costume, runtime, _rotationCenter) {
//     return fetchBitmapCanvas_(costume, runtime, _rotationCenter)
//         .then(fetched => {
//             const updateCostumeAsset = function (dataURI) {
//                 if (!runtime.v2BitmapAdapter) {
//                     // TODO: This might be a bad practice since the returned
//                     // promise isn't acted on. If this is something we should be
//                     // creating a rejected promise for we should also catch it
//                     // somewhere and act on that error (like logging).
//                     //
//                     // Return a rejection to stop executing updateCostumeAsset.
//                     return Promise.reject('No V2 Bitmap adapter present.');
//                 }
//
//                 const storage = runtime.storage;
//                 costume.asset = storage.createAsset(
//                     storage.AssetType.ImageBitmap,
//                     storage.DataFormat.PNG,
//                     runtime.v2BitmapAdapter.convertDataURIToBinary(dataURI),
//                     null,
//                     true // generate md5
//                 );
//                 costume.dataFormat = storage.DataFormat.PNG;
//                 costume.assetId = costume.asset.assetId;
//                 costume.md5 = `${costume.assetId}.${costume.dataFormat}`;
//             };
//
//             if (!fetched.assetMatchesBase) {
//                 updateCostumeAsset(fetched.canvas.toDataURL());
//             }
//
//             return fetched;
//         })
//         .then(({canvas, mergeCanvas, rotationCenter}) => {
//             // createBitmapSkin does the right thing if costume.bitmapResolution or rotationCenter are undefined...
//             costume.skinId = runtime.renderer.createBitmapSkin(canvas, costume.bitmapResolution, rotationCenter);
//             canvasPool.release(mergeCanvas);
//             const renderSize = runtime.renderer.getSkinSize(costume.skinId);
//             costume.size = [renderSize[0] * 2, renderSize[1] * 2]; // Actual size, since all bitmaps are resolution 2
//
//             if (!rotationCenter) {
//                 rotationCenter = runtime.renderer.getSkinRotationCenter(costume.skinId);
//                 // Actual rotation center, since all bitmaps are resolution 2
//                 costume.rotationCenterX = rotationCenter[0] * 2;
//                 costume.rotationCenterY = rotationCenter[1] * 2;
//                 costume.bitmapResolution = 2;
//             }
//             return costume;
//         });
// };

const loadBitmap_ = (function () {
    const {Branch, GeneratedFunction, Parallel, Sequence} = LoadTask;
    const firstLoad = new Sequence([
        // new GeneratedFunction(loadAspect.loadAsset, {}),
        new GeneratedFunction(loadBitmapFromAsset, {}),
    ]);
    const tasks = new Sequence([
        new Parallel([
            new Sequence([
                firstLoad,
                new GeneratedFunction(loadBitmapCanvas, {}),
            ]),
            new Branch(new GeneratedFunction(loadCostumeHasTextLayer, {}), firstLoad.withConfig({
                field: 'textLayerAsset'
            })),
        ]),
        // new Branch(new GeneratedFunction(loadCostumeHasTextLayer, {}), new GeneratedFunction(loadBitmapUpgradeTextLayer, {})),
        // new Branch(new GeneratedFunction(loadCostumeHasWrongScale, {}), new GeneratedFunction(loadBitmapUpgradeScale, {})),
        // new Branch(new GeneratedFunction(loadCostumeUpgrades, {}), new GeneratedFunction(loadAspect.saveAsset, {})),
        new GeneratedFunction(loadBitmapRender, {}),
        new GeneratedFunction(loadCostumeUpdateSkinRotationCenter, {}),
        new GeneratedFunction(loadCostumeScaleSkinRotationCenter, {scale: 2}),
        new GeneratedFunction(loadBitmapCanvasCleanup, {}),
    ]);
    return function (costume, runtime, rotationCenter) {
        return tasks.run({costume}, {runtime, rotationCenter})
            .then(() => costume)
    };
}());

/**
 * Initialize a costume from an asset asynchronously.
 * Do not call this unless there is a renderer attached.
 * @param {!object} costume - the Scratch costume object.
 * @property {int} skinId - the ID of the costume's render skin, once installed.
 * @property {number} rotationCenterX - the X component of the costume's origin.
 * @property {number} rotationCenterY - the Y component of the costume's origin.
 * @property {number} [bitmapResolution] - the resolution scale for a bitmap costume.
 * @property {!Asset} costume.asset - the asset of the costume loaded from storage.
 * @param {!Runtime} runtime - Scratch runtime, used to access the storage module.
 * @param {?int} optVersion - Version of Scratch that the costume comes from. If this is set
 *     to 2, scratch 3 will perform an upgrade step to handle quirks in SVGs from Scratch 2.0.
 * @returns {?Promise} - a promise which will resolve after skinId is set, or null on error.
 */
const loadCostumeFromAsset = function (costume, runtime, optVersion) {
    costume.assetId = costume.asset.assetId;
    const renderer = runtime.renderer;
    if (!renderer) {
        log.error('No rendering module present; cannot load costume: ', costume.name);
        return Promise.resolve(costume);
    }
    const AssetType = runtime.storage.AssetType;
    let rotationCenter;
    // Use provided rotation center and resolution if they are defined. Bitmap resolution
    // should only ever be 1 or 2.
    if (typeof costume.rotationCenterX === 'number' && !isNaN(costume.rotationCenterX) &&
            typeof costume.rotationCenterY === 'number' && !isNaN(costume.rotationCenterY)) {
        rotationCenter = [costume.rotationCenterX, costume.rotationCenterY];
    }
    if (costume.asset.assetType.runtimeFormat === AssetType.ImageVector.runtimeFormat) {
        return loadVector_(costume, runtime, rotationCenter, optVersion)
            .catch(() => {
                // Use default asset if original fails to load
                costume.assetId = runtime.storage.defaultAssetId.ImageVector;
                costume.asset = runtime.storage.get(costume.assetId);
                costume.md5 = `${costume.assetId}.${AssetType.ImageVector.runtimeFormat}`;
                return loadVector_(costume, runtime);
            });
    }
    return loadBitmap_(costume, runtime, rotationCenter, optVersion);
};

/**
 * Load a costume's asset into memory asynchronously.
 * Do not call this unless there is a renderer attached.
 * @param {!string} md5ext - the MD5 and extension of the costume to be loaded.
 * @param {!object} costume - the Scratch costume object.
 * @property {int} skinId - the ID of the costume's render skin, once installed.
 * @property {number} rotationCenterX - the X component of the costume's origin.
 * @property {number} rotationCenterY - the Y component of the costume's origin.
 * @property {number} [bitmapResolution] - the resolution scale for a bitmap costume.
 * @param {!Runtime} runtime - Scratch runtime, used to access the storage module.
 * @param {?int} optVersion - Version of Scratch that the costume comes from. If this is set
 *     to 2, scratch 3 will perform an upgrade step to handle quirks in SVGs from Scratch 2.0.
 * @returns {?Promise} - a promise which will resolve after skinId is set, or null on error.
 */
// const loadCostume = function (md5ext, costume, runtime, optVersion) {
//     const idParts = StringUtil.splitFirst(md5ext, '.');
//     const md5 = idParts[0];
//     const ext = idParts[1].toLowerCase();
//     costume.dataFormat = ext;
//
//     if (costume.asset) {
//         // Costume comes with asset. It could be coming from camera, image upload, drag and drop, or file
//         return loadCostumeFromAsset(costume, runtime, optVersion);
//     }
//
//     // Need to load the costume from storage. The server should have a reference to this md5.
//     if (!runtime.storage) {
//         log.error('No storage module present; cannot load costume asset: ', md5ext);
//         return Promise.resolve(costume);
//     }
//
//     if (!runtime.storage.defaultAssetId) {
//         log.error(`No default assets found`);
//         return Promise.resolve(costume);
//     }
//
//     const AssetType = runtime.storage.AssetType;
//     const assetType = (ext === 'svg') ? AssetType.ImageVector : AssetType.ImageBitmap;
//
//     const costumePromise = runtime.storage.load(assetType, md5, ext);
//     if (!costumePromise) {
//         log.error(`Couldn't fetch costume asset: ${md5ext}`);
//         return;
//     }
//
//     let textLayerPromise;
//     if (costume.textLayerMD5) {
//         textLayerPromise = runtime.storage.load(AssetType.ImageBitmap, costume.textLayerMD5, 'png');
//     } else {
//         textLayerPromise = Promise.resolve(null);
//     }
//
//     return Promise.all([costumePromise, textLayerPromise]).then(assetArray => {
//         costume.asset = assetArray[0];
//         if (assetArray[1]) {
//             costume.textLayerAsset = assetArray[1];
//         }
//         return loadCostumeFromAsset(costume, runtime, optVersion);
//     });
// };

const loadCostumeIsVector = function ({

}) {
    return function ({costume, ext}, {runtime: {storage: {AssetType}}}) {
        return ext === 'svg';
        // return costume.asset.assetType.runtimeFormat === AssetType.ImageVector.runtimeFormat;
    };
};

const loadVectorWrapper = function ({

}) {
    return function ({costume, rotationCenter}, {runtime, optVersion}) {
        return loadVector_(costume, runtime, rotationCenter, optVersion);
    };
};


const loadBitmapWrapper = function ({

}) {
    return function ({costume, rotationCenter}, {runtime}) {
        return loadBitmap_(costume, runtime, rotationCenter);
    };
};

const loadCostumeAfterLoad = function ({

}) {
    return function (scope, {runtime}) {
        const {costume} = scope;

        costume.assetId = costume.asset.assetId;
        const renderer = runtime.renderer;
        if (!renderer) {
            log.error('No rendering module present; cannot load costume: ', costume.name);
            throw new Error('Cannot finish loadCostumeAfterLoad');
        }

        // Use provided rotation center and resolution if they are defined.
        // Bitmap resolution should only ever be 1 or 2.
        if (typeof costume.rotationCenterX === 'number' && !isNaN(costume.rotationCenterX) &&
            typeof costume.rotationCenterY === 'number' && !isNaN(costume.rotationCenterY)) {
            scope.rotationCenter = [costume.rotationCenterX, costume.rotationCenterY];
        }
    };
};

const loadCostume = (function () {
    const {Branch, DerefScope, GeneratedFunction, MayFail, Parallel, Sequence} = LoadTask;
    const firstBitmapLoad = new Sequence([
        new GeneratedFunction(loadAspect.loadBulk, {}),
        new MayFail(new DerefScope('costume', new GeneratedFunction(loadAspect.loadAssetFromBulk, {
            formatOf: ({dataFormat}) => dataFormat,
            typeOf: (scope, {runtime: {storage: {AssetType}}}) => AssetType.ImageBitmap
        }))),
        new DerefScope('costume', new GeneratedFunction(loadAspect.loadAsset, {
            formatOf: ({dataFormat}) => dataFormat,
            typeOf: ({dataFormat}, {runtime: {storage: {AssetType}}}) => (dataFormat === 'svg') ? AssetType.ImageVector : AssetType.ImageBitmap
        })),
        new GeneratedFunction(loadBitmapFromAsset, {}),
    ]);
    const tasks = new Branch(new GeneratedFunction(loadCostumeIsVector, {}),
        new Sequence([
            new Parallel([
                new GeneratedFunction(loadAspect.loadBulk, {}),
                new Sequence([
                    new MayFail(new DerefScope('costume', new GeneratedFunction(loadAspect.loadAssetFromBulk, {
                        formatOf: ({dataFormat}) => dataFormat,
                        typeOf: (scope, {runtime: {storage: {AssetType}}}) => AssetType.ImageVector
                    }))),
                    new DerefScope('costume', new GeneratedFunction(loadAspect.loadAsset, {
                        formatOf: ({dataFormat}) => dataFormat,
                        typeOf: (scope, {runtime: {storage: {AssetType}}}) => AssetType.ImageVector
                    })),
                ]),
                new Branch(new GeneratedFunction(loadCostumeInDerived, {}),
                    new Sequence([
                        new MayFail(new DerefScope('costume', new GeneratedFunction(loadAspect.loadAssetFromBulk, {
                            assetName: 'derived costume',
                            field: 'derivedAsset',
                            fieldId: null,
                            fieldMd5: null,
                            generateMd5: false,
                            formatOf: () => 'json',
                            md5Of: ({asset, assetId}, {runtime}) => runtime.derived[assetId || asset.assetId].assetId,
                            typeOf: (scope, {runtime: {storage: {AssetType}}}) => AssetType.ImageVector
                        }))),
                        new MayFail(new DerefScope('costume', new GeneratedFunction(loadAspect.loadAsset, {
                            assetName: 'derived costume',
                            field: 'derivedAsset',
                            fieldId: null,
                            fieldMd5: null,
                            generateMd5: false,
                            formatOf: () => 'json',
                            md5Of: ({asset, assetId}, {runtime}) => runtime.derived[assetId || asset.assetId].assetId,
                            typeOf: (scope, {runtime: {storage: {AssetType}}}) => AssetType.ImageVector
                        })))
                    ])
                )
            ]),
            new GeneratedFunction(loadCostumeAfterLoad, {}),
            new GeneratedFunction(loadVectorWrapper, {}),
        ]),
        new Branch(new GeneratedFunction(loadCostumeInAtlas, {}),
            new Sequence([
                new GeneratedFunction(loadAtlasMapCanvas, {
                    loadAsset: new Sequence([
                        new MayFail(new Sequence([
                            new GeneratedFunction(loadAspect.loadBulk, {}),
                            new GeneratedFunction(loadAtlasMapFromBulk, {}),
                        ])),
                        new GeneratedFunction(loadAtlasMapAsset, {}),
                    ]),
                }),
                new GeneratedFunction(loadBitmapFromAtlas, {}),
                new GeneratedFunction(loadCostumeAfterLoad, {}),
                new GeneratedFunction(loadBitmapRender, {}),
                new GeneratedFunction(loadCostumeUpdateSkinRotationCenter, {}),
                new GeneratedFunction(loadCostumeScaleSkinRotationCenter, {scale: 2}),
            ]),
            new Sequence([
                new Parallel([
                    new Sequence([
                        firstBitmapLoad,
                        new GeneratedFunction(loadCostumeAfterLoad, {}),
                        new GeneratedFunction(loadBitmapCanvas, {}),
                    ]),
                    new Branch(new GeneratedFunction(loadCostumeHasTextLayer, {}),
                        firstBitmapLoad.withConfig({
                            elementField: 'textImageElement',
                            field: 'textLayerAsset',
                            formatOf: () => 'png',
                            md5Of: ({textLayerMD5}) => textLayerMD5,
                            typeOf: (scope, {runtime: {storage: {AssetType}}}) => AssetType.ImageBitmap
                        })
                    ),
                ]),
                new Branch(new GeneratedFunction(loadCostumeHasTextLayer, {}), new GeneratedFunction(loadBitmapUpgradeTextLayer, {})),
                new Branch(new GeneratedFunction(loadCostumeHasWrongScale, {}), new GeneratedFunction(loadBitmapUpgradeScale, {})),
                new Branch(new GeneratedFunction(loadCostumeUpgrades, {}), new DerefScope('costume', new GeneratedFunction(loadAspect.saveAsset, {}))),
                new GeneratedFunction(loadBitmapRender, {}),
                new GeneratedFunction(loadCostumeUpdateSkinRotationCenter, {}),
                new GeneratedFunction(loadCostumeScaleSkinRotationCenter, {scale: 2}),
                new GeneratedFunction(loadBitmapCanvasCleanup, {}),
            ])
        )
    );
    return async function (md5ext, costume, runtime, optVersion) {
        const idParts = StringUtil.splitFirst(md5ext, '.');
        const md5 = idParts[0];
        const ext = idParts[1].toLowerCase();
        costume.dataFormat = ext;

        // window.COSTUME_INDEX = (window.COSTUME_INDEX | 0) + 1;

        if (!costume.asset) {
            // Need to load the costume from storage. The server should have a reference to this md5.
            if (!runtime.storage) {
                log.error('No storage module present; cannot load costume asset: ', md5ext);
                return Promise.resolve(costume);
            }

            if (!runtime.storage.defaultAssetId) {
                log.error(`No default assets found`);
                return Promise.resolve(costume);
            }
        }

        return tasks.run({costume, md5ext, md5, ext}, {runtime, optVersion})
            .then(() => (
                // console.log('done', window.COSTUME_INDEX = (window.COSTUME_INDEX | 0) - 1, costume, costume.assetId),
                costume
            ))
            .catch(() => (
                // console.log('fail', window.COSTUME_INDEX_CATCH = (window.COSTUME_INDEX_CATCH | 0) + 1),
                costume
            ));
    };
}());

module.exports = {
    loadCostume,
    loadCostumeFromAsset
};
