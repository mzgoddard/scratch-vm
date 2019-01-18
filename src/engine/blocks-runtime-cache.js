class Script {
    constructor (container, blockId) {
        this.container = container;
        this.blockId = blockId;
        this.block = container.getBlock(blockId);
        this.fields = container.getFields(this.block);
        this.inputs = container.getInputs(this.block);

        // don't overwrite the block's actual fields list
        this.fieldsOfInputs = Object.assign({}, this.fields);
        if (Object.keys(this.fields).length === 0) {
            for (const input in this.inputs) {
                if (!hatInputs.hasOwnProperty(input)) continue;
                const id = hatInputs[input].block;
                const inpBlock = container.getBlock(id);
                const fields = container.getFields(inpBlock);
                Object.assign(this.fieldsOfInputs, fields);
            }
        }
        for (const key in this.fieldsOfInputs) {
            const fields = this.fieldsOfInputs[key] = Object.assign({}, this.fieldsOfInputs[key]);
            if (fields.value.toUpperCase) {
                fields.value = fields.value.toUpperCase();
            }
        }
    }
}

exports.getScripts = function () {};

exports.Script = Script;

require('./blocks');
