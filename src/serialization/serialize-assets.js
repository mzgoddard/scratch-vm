const LoadBulk = require('../import/load-bulk').Bulk;

/**
 * Serialize all the assets of the given type ('sounds' or 'costumes')
 * in the provided runtime into an array of file descriptors.
 * A file descriptor is an object containing the name of the file
 * to be written and the contents of the file, the serialized asset.
 * @param {Runtime} runtime The runtime with the assets to be serialized
 * @param {string} assetType The type of assets to be serialized: 'sounds' | 'costumes'
 * @param {string=} optTargetId Optional target id to serialize assets for
 * @returns {Array<object>} An array of file descriptors for each asset
 */
const serializeAssets = function (runtime, assetType, optTargetId) {
    const targets = optTargetId ? [runtime.getTargetById(optTargetId)] : runtime.targets;
    const assetDescs = [];
    for (let i = 0; i < targets.length; i++) {
        const currTarget = targets[i];
        const currAssets = currTarget.sprite[assetType];
        for (let j = 0; j < currAssets.length; j++) {
            const currAsset = currAssets[j];
            const asset = currAsset.asset;
            assetDescs.push({
                fileName: `${asset.assetId}.${asset.dataFormat}`,
                fileContent: asset.data});

            runtime.bulk = runtime.bulk || new LoadBulk();
            runtime.bulk.add({
                assetId: asset.assetId,
                dataFormat: asset.dataFormat,
                data: asset.data
            });

            if (asset._imageData && asset.dataFormat === 'png') {
                runtime.atlas = runtime.atlas || new Atlas();

                if (!runtime.atlas.findTile(asset.assetId)) {
                    runtime.atlas.createTile({
                        asset: runtime.atlas.createAsset({
                            assetId: asset.assetId,
                            dataFormat: asset.dataFormat,
                            imageData: asset._imageData
                        }),
                        map: null,
                        tile: null
                    });
                }
            }

            const derivedAsset = currAsset.derivedAsset;
            if (derivedAsset) {
                runtime.derived = runtime.derived || {};

                runtime.derived[asset.assetId] = {
                    assetId: derivedAsset.assetId,
                    dataFormat: derivedAsset.dataFormat
                };
                assetDescs.push({
                    fileName: `${derivedAsset.assetId}.${derivedAsset.dataFormat}`,
                    fileContent: derivedAsset.data});

                runtime.bulk = runtime.bulk || new LoadBulk();
                runtime.bulk.add({
                    assetId: derivedAsset.assetId,
                    dataFormat: derivedAsset.dataFormat,
                    data: derivedAsset.data
                });
            }
        }
    }
    return assetDescs;
};

/**
 * Serialize all the sounds in the provided runtime or, if a target id is provided,
 * in the specified target into an array of file descriptors.
 * A file descriptor is an object containing the name of the file
 * to be written and the contents of the file, the serialized sound.
 * @param {Runtime} runtime The runtime with the sounds to be serialized
 * @param {string=} optTargetId Optional targetid for serializing sounds of a single target
 * @returns {Array<object>} An array of file descriptors for each sound
 */
const serializeSounds = function (runtime, optTargetId) {
    return serializeAssets(runtime, 'sounds', optTargetId);
};

/**
 * Serialize all the costumes in the provided runtime into an array of file
 * descriptors. A file descriptor is an object containing the name of the file
 * to be written and the contents of the file, the serialized costume.
 * @param {Runtime} runtime The runtime with the costumes to be serialized
 * @param {string} optTargetId Optional targetid for serializing costumes of a single target
 * @returns {Array<object>} An array of file descriptors for each costume
 */
const serializeCostumes = function (runtime, optTargetId) {
    return serializeAssets(runtime, 'costumes', optTargetId);
};

module.exports = {
    serializeSounds,
    serializeCostumes
};
