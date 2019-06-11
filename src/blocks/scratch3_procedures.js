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
            // procedures_definition is the top block of a procedure but has no
            // effect of its own.
            procedures_definition: null,

            procedures_call: this.call,
            argument_reporter_string_number: this.argumentReporterStringNumber,
            argument_reporter_boolean: this.argumentReporterBoolean
        };
    }

    call (args, util) {
        const procedureCode = args.mutation.proccode;
        const procedureInfo = util.getProcedureInfo(procedureCode);

        // If null, procedure could not be found, which can happen if custom
        // block is dragged between sprites without the definition.
        // Match Scratch 2.0 behavior and noop.
        if (procedureInfo === null) {
            return;
        }

        util.startProcedure(procedureInfo);

        // Initialize params for the current stackFrame to {}, even if the
        // procedure does not take any arguments. This is so that `getParam`
        // down the line does not look at earlier stack frames for the values of
        // a given parameter (#1729)
        util.initParams(procedureInfo, args);
    }

    argumentReporterStringNumber (args, util) {
        // getParam will return a stored value or the default 0.
        return util.getParam(args.VALUE);
    };

    argumentReporterBoolean (args, util) {
        // getParam will return a stored value or the default 0.
        return util.getParam(args.VALUE);
    }
}

module.exports = Scratch3ProcedureBlocks;
