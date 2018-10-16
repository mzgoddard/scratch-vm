const BlockDefinition = require('../engine/block-definition');

class Scratch3ProcedureBlocks {
    constructor (runtime) {
        /**
         * The runtime instantiating this block package.
         * @type {Runtime}
         */
        this.runtime = runtime;
    }

    /**
     * Retrieve the block primitives implemented by this package.
     * @return {object.<string, Function>} Mapping of opcode to Function.
     */
    getPrimitives () {
        return {
            procedures_definition: this.definition,
            procedures_call: this.call,
            argument_reporter_string_number: this.argumentReporterStringNumber,
            argument_reporter_boolean: this.argumentReporterBoolean
        };
    }

    definition () {
        // No-op: execute the blocks.
    }

    static get call_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            return: BlockDefinition.Type.None
        };
    }

    call (args, util) {
        if (!util.stackFrame.executed) {
            const procedureCode = args.mutation.proccode;
            const paramNamesIdsAndDefaults = util.getProcedureParamNamesIdsAndDefaults(procedureCode);

            // If null, procedure could not be found, which can happen if custom
            // block is dragged between sprites without the definition.
            // Match Scratch 2.0 behavior and noop.
            if (paramNamesIdsAndDefaults === null) {
                return;
            }

            const [paramNames, paramIds, paramDefaults] = paramNamesIdsAndDefaults;

            for (let i = 0; i < paramIds.length; i++) {
                if (args.hasOwnProperty(paramIds[i])) {
                    util.pushParam(paramNames[i], args[paramIds[i]]);
                } else {
                    util.pushParam(paramNames[i], paramDefaults[i]);
                }
            }

            util.stackFrame.executed = true;
            util.startProcedure(procedureCode);
        }
    }

    static get argumentReporterStringNumber_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            arguments: {
                VALUE: BlockDefinition.Type.String
            },
            return: BlockDefinition.Type.StringNumber
        };
    }

    argumentReporterStringNumber (args, util) {
        const value = util.getParam(args.VALUE);
        if (value === null) {
            return '';
        }
        return value;
    }

    static get argumentReporterBoolean_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            arguments: {
                VALUE: BlockDefinition.Type.String
            },
            return: BlockDefinition.Type.Boolean
        };
    }

    argumentReporterBoolean (args, util) {
        const value = util.getParam(args.VALUE);
        if (value === null) {
            return false;
        }
        return value;
    }
}

BlockDefinition.decorateBlockFunctions(Scratch3ProcedureBlocks);

module.exports = Scratch3ProcedureBlocks;
