const JSZip = require('jszip');
const log = require('../util/log');

const regeneratorRuntime = require('regenerator-runtime');

const LoadBulk = require('./load-bulk').Bulk;

const loadAspectMissingAsset = function ({field = 'asset'}) {
    return function (aspect) {
        return !aspect[field];
    };
};

const arrayFrom = function (obj) {
    if (Array.isArray(obj)) {
        return obj;
    } else if (aspect[field].length >= 0) {
        return Array.from(obj);
    }
    return Object.keys(obj).map(key => obj[key]);
};
const loadAspectDuplicateAssetData = function ({
    field = 'asset'
} = {}) {
    return function (aspect, options) {
        if (aspect[field]) {
            aspect[field].data = new Uint8Array(arrayFrom(aspect[field].data));
        }
        return aspect;
    };
};
const loadCostumeFormatOf = function () {
    return function (asset) {
        return asset.dataFormat.toLowerCase();
    };
};
const loadCostumeTypeOf = function ({
    assetName = 'costume',
    formatOf = loadCostumeFormatOf({assetName})
}) {
    return function (asset, options) {
        const {runtime: {storage}} = options;
        let assetType = null;
        const aspectFormat = formatOf(asset, options);
        if (aspectFormat === 'svg') {
            assetType = storage.AssetType.ImageVector;
        } else if (['png', 'bmp', 'jpeg', 'jpg', 'gif'].indexOf(aspectFormat) >= 0) {
            assetType = storage.AssetType.ImageBitmap;
        } else {
            log.error(`Unexpected file format for ${assetName}: ${aspectFormat}`);
        }
        return assetType;
    };
};
const loadAspectReadZipAsset = function ({
    // Debug name if the file cannot be found.
    assetName = 'costume',
    field_ = '',
    field = field_ === '' ? 'asset' : `${field_}Asset`,
    fieldId = field_ === '' ? 'assetId' : `${field_}ID`,
    fieldMd5 = field_ === '' ? 'md5' : `${field_}MD5`,
    fieldFileName = field_ === '' ? 'assetFileName' : `${field_}FileName`,
    formatOf = loadCostumeFormatOf({assetName}),
    typeOf = loadCostumeTypeOf({assetName, formatOf})
}) {
    return function (aspect, options) {
        const {runtime, zip} = options;
        const storage = runtime.storage;
        const fileName = options[fieldFileName] ? options[fieldFileName] :
            aspect[fieldId] ? `${aspect[fieldId]}.${aspect.dataFormat}` :
            aspect[fieldMd5];

        if (aspect[field]) {
            return Promise.resolve(null);
        }

        if (!zip) {
            return;
        }

        if (!storage) {
            log.error(`No storage module present; cannot load ${assetName} asset: ${fileName}`);
            return Promise.resolve(null);
        }

        let file = zip.file(fileName);
        if (!file && field === 'asset') {
            // look for assetfile in a flat list of files, or in a folder
            const fileMatch = new RegExp(`^([^/]*/)?${fileName}$`);
            file = zip.file(fileMatch)[0]; // use the first matched file
        }

        if (!file) {
            log.error(`Could not find ${assetName} file associated with the ${aspect.name} costume.`);
            return Promise.resolve(null);
        }

        // Call before testing zip array support so error messages may be
        // emitted.
        const dataFormat = formatOf(aspect, options);
        const assetType = typeOf(aspect, options);

        if (!JSZip.support.uint8array) {
            log.error('JSZip uint8array is not supported in this browser.');
            return Promise.resolve(null);
        }

        // textLayerMD5 exists if there is a text layer, which is a png of text
        // from Scratch 1.4 that was opened in Scratch 2.0. In this case, set
        // costume.textLayerAsset.

        return file.async('uint8array')
            .then(data => {
                aspect[field] = {
                    assetType,
                    dataFormat,
                    data
                };
                return aspect;
            });
    };
};
const loadAspectReadZipAssetMap = function (aspect, options) {

};
const loadAspectSaveAsset = function ({
    assetName = 'costume',
    field_ = '',
    field = field_ === '' ? 'asset' : `${field_}Asset`,
    fieldId = field_ === '' ? 'assetId' : `${field_}ID`,
    fieldMd5 = field === 'asset' ? 'md5' : `${field_}Md5`,
    generateMd5 = false,
    formatOf = asset => asset.dataFormat,
    typeOf = asset => asset.assetType
}) {
    return function (aspect, options) {
        if (aspect[field]) {
            const {runtime} = options;
            const storage = runtime.storage;
            if (!storage) {
                log.error(`No storage module present; cannot load ${assetName} asset`);
                return Promise.resolve(null);
            }

            // When uploading a sprite from an image file, the asset data will
            // be provided
            // @todo Cache the asset data somewhere and pull it out here
            return Promise.resolve(storage.createAsset(
                typeOf(aspect[field], options),
                formatOf(aspect[field], options),
                aspect[field].data,
                !generateMd5 && aspect[fieldMd5] ? aspect[fieldMd5] : null,
                generateMd5 || !aspect[fieldMd5]
            )).then(asset => {
                aspect[field] = asset;
                if (fieldId) {
                    aspect[fieldId] = asset.assetId;
                }
                if (fieldMd5) {
                    aspect[fieldMd5] = `${asset.assetId}.${asset.dataFormat}`;
                }
                return aspect;
            });
        }
        return aspect;
    };
};
const loadAspectLoadAsset = function ({
    assetName = 'costume',
    field_ = '',
    field = field_ === '' ? 'asset' : `${field_}Asset`,
    fieldId = field_ === '' ? 'assetId' : `${field_}ID`,
    fieldMd5 = field === 'asset' ? 'md5' : `${field_}Md5`,
    generateMd5 = false,
    formatOf = asset => asset.dataFormat,
    typeOf = asset => asset.assetType,
    md5Of = asset => asset[fieldMd5].split('.')[0]
}) {
    return function (aspect, options) {
        if (!aspect[field]) {
            const {runtime} = options;
            const dataFormat = formatOf(aspect, options);
            const md5 = md5Of(aspect, options);
            const assetType = typeOf(aspect, options);
            const promise = runtime.storage.load(assetType, md5, dataFormat)
            .then(asset => {
                aspect[field] = asset;
                if (fieldId) {
                    aspect[fieldId] = asset.assetId;
                }
                if (fieldMd5) {
                    aspect[fieldMd5] = `${asset.assetId}.${asset.dataFormat}`;
                }
                return aspect;
            })
            .catch((error) => {
                log.error(`Couldn't fetch ${assetName} asset: ${md5}.${dataFormat}`);
            });
            if (promise) {
                return promise;
            } else {
                log.error(`Couldn't fetch ${assetName} asset: ${md5}.${dataFormat}`);
                throw new Error('Could not complete loadAspect.loadAsset');
            }
        }
    };
};
const loadAspectLoadBulk = function ({
}) {
    return function (scope, {runtime}) {
        if (runtime.bulk && runtime.bulk.length > 0 && typeof runtime.bulk[0] === 'string') {
            runtime.bulk = LoadBulk.fromSliceAssets(runtime.bulk.map(assetId => {
                return runtime.storage.load({
                    contentType: 'octet/bitstream',
                    name: 'Bulk',
                    runtimeFormat: 'bulk',
                    immutable: true
                }, assetId, 'bulk');
            }));
        }
    };
};
const loadAspectLoadAssetFromBulk = function ({
    assetName = 'costume',
    field_ = '',
    field = field_ === '' ? 'asset' : `${field_}Asset`,
    fieldId = field_ === '' ? 'assetId' : `${field_}ID`,
    fieldMd5 = field === 'asset' ? 'md5' : `${field_}Md5`,
    generateMd5 = false,
    formatOf = asset => asset.dataFormat,
    typeOf = asset => asset.assetType,
    md5Of = asset => asset[fieldMd5].split('.')[0]
}) {
    return function (aspect, options) {
        const {runtime} = options;
        if (runtime.bulk) {
            const dataFormat = formatOf(aspect, options);
            const md5 = md5Of(aspect, options);
            const assetType = typeOf(aspect, options);
            return Promise.resolve(runtime.bulk.find(md5))
            .then(function (asset) {
                return runtime.storage.createAsset(
                    assetType,
                    dataFormat,
                    asset.data,
                    md5
                );
            })
            .then(function (asset) {
                aspect[field] = asset;
                if (fieldId) {
                    aspect[fieldId] = asset.assetId;
                }
                if (fieldMd5) {
                    aspect[fieldMd5] = `${asset.assetId}.${asset.dataFormat}`;
                }
                return aspect;
            });
        }
        throw new Error('No bulk');
    };
};

module.exports = {
    missingAsset: loadAspectMissingAsset,
    formatOf: loadCostumeFormatOf,
    typeOf: loadCostumeTypeOf,

    duplicateAssetData: loadAspectDuplicateAssetData,
    readZipAsset: loadAspectReadZipAsset,
    readZipAssetMap: loadAspectReadZipAssetMap,
    saveAsset: loadAspectSaveAsset,
    loadAsset: loadAspectLoadAsset,
    loadBulk: loadAspectLoadBulk,
    loadAssetFromBulk: loadAspectLoadAssetFromBulk
};
