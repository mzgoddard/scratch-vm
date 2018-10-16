const BlockUtility = require('./block-utility');
const BlocksExecuteCache = require('./blocks-execute-cache');
const log = require('../util/log');
const Thread = require('./thread');
const {Map} = require('immutable');
const cast = require('../util/cast');
const BlockDefinition = require('./block-definition');

/**
 * Single BlockUtility instance reused by execute for every pritimive ran.
 * @const
 */
const blockUtility = new BlockUtility();

/**
 * Profiler frame name for block functions.
 * @const {string}
 */
const blockFunctionProfilerFrame = 'blockFunction';

/**
 * Profiler frame ID for 'blockFunction'.
 * @type {number}
 */
let blockFunctionProfilerId = -1;

/**
 * Utility function to determine if a value is a Promise.
 * @param {*} value Value to check for a Promise.
 * @return {boolean} True if the value appears to be a Promise.
 */
const isPromise = function (value) {
    return (
        value !== null &&
        typeof value === 'object' &&
        typeof value.then === 'function'
    );
};

/**
 * Handle any reported value from the primitive, either directly returned
 * or after a promise resolves.
 * @param {*} resolvedValue Value eventually returned from the primitive.
 * @param {!Sequencer} sequencer Sequencer stepping the thread for the ran
 * primitive.
 * @param {!Thread} thread Thread containing the primitive.
 * @param {!string} currentBlockId Id of the block in its thread for value from
 * the primitive.
 * @param {!string} opcode opcode used to identify a block function primitive.
 * @param {!boolean} isHat Is the current block a hat?
 */
// @todo move this to callback attached to the thread when we have performance
// metrics (dd)
const handleReport = function (resolvedValue, sequencer, thread, blockCached, lastOperation) {
    const currentBlockId = blockCached.id;
    const opcode = blockCached.opcode;
    const isHat = blockCached._isHat;

    thread.pushReportedValue(resolvedValue);
    if (isHat) {
        // Hat predicate was evaluated.
        if (sequencer.runtime.getIsEdgeActivatedHat(opcode)) {
            // If this is an edge-activated hat, only proceed if the value is
            // true and used to be false, or the stack was activated explicitly
            // via stack click
            if (!thread.stackClick) {
                const oldEdgeValue = sequencer.runtime.updateEdgeActivatedValue(
                    currentBlockId,
                    resolvedValue
                );
                const edgeWasActivated = !oldEdgeValue && resolvedValue;
                if (!edgeWasActivated) {
                    sequencer.retireThread(thread);
                }
            }
        } else if (!resolvedValue) {
            // Not an edge-activated hat: retire the thread
            // if predicate was false.
            sequencer.retireThread(thread);
        }
    } else {
        // In a non-hat, report the value visually if necessary if
        // at the top of the thread stack.
        if (lastOperation && typeof resolvedValue !== 'undefined' && thread.atStackTop()) {
            if (thread.stackClick) {
                sequencer.runtime.visualReport(currentBlockId, resolvedValue);
            }
            if (thread.updateMonitor) {
                const targetId = sequencer.runtime.monitorBlocks.getBlock(currentBlockId).targetId;
                if (targetId && !sequencer.runtime.getTargetById(targetId)) {
                    // Target no longer exists
                    return;
                }
                sequencer.runtime.requestUpdateMonitor(Map({
                    id: currentBlockId,
                    spriteName: targetId ? sequencer.runtime.getTargetById(targetId).getName() : null,
                    value: resolvedValue
                }));
            }
        }
        // Finished any yields.
        thread.status = Thread.STATUS_RUNNING;
    }
};

const handlePromise = (primitiveReportedValue, sequencer, thread, blockCached, lastOperation) => {
    if (thread.status === Thread.STATUS_RUNNING) {
        // Primitive returned a promise; automatically yield thread.
        thread.status = Thread.STATUS_PROMISE_WAIT;
    }
    // Promise handlers
    primitiveReportedValue.then(resolvedValue => {
        handleReport(resolvedValue, sequencer, thread, blockCached, lastOperation);
        // If its a command block.
        if (lastOperation && typeof resolvedValue === 'undefined') {
            let stackFrame;
            let nextBlockId;
            do {
                // In the case that the promise is the last block in the current thread stack
                // We need to pop out repeatedly until we find the next block.
                const popped = thread.popStack();
                if (popped === null) {
                    return;
                }
                nextBlockId = thread.target.blocks.getNextBlock(popped);
                if (nextBlockId !== null) {
                    // A next block exists so break out this loop
                    break;
                }
                // Investigate the next block and if not in a loop,
                // then repeat and pop the next item off the stack frame
                stackFrame = thread.peekStackFrame();
            } while (stackFrame !== null && !stackFrame.isLoop);

            thread.pushStack(nextBlockId);
        }
    }, rejectionReason => {
        // Promise rejected: the primitive had some error.
        // Log it and proceed.
        log.warn('Primitive rejected promise: ', rejectionReason);
        thread.status = Thread.STATUS_RUNNING;
        thread.popStack();
    });
};

class VariableValues {
    constructor ({mutation, VARIABLE}) {
        this.mutation = mutation;
        this.VARIABLE = VARIABLE;
    }
}

class Num2Values {
    constructor ({mutation, NUM1, NUM2}) {
        this.mutation = mutation;
        this.NUM1 = cast.toNumber(NUM1);
        this.NUM2 = cast.toNumber(NUM2);
    }
}

class NumValues {
    constructor ({mutation, NUM}) {
        this.mutation = mutation;
        this.NUM = cast.toNumber(NUM);
    }
}

class Operand2Values {
    constructor ({mutation, OPERAND1, OPERAND2}) {
        this.mutation = mutation;
        this.OPERAND1 = OPERAND1;
        this.OPERAND2 = OPERAND2;
    }
}

class ConditionValues {
    constructor ({mutation, CONDITION}) {
        this.mutation = mutation;
        this.CONDITION = CONDITION;
    }
}

/**
 * A execute.js internal representation of a block to reduce the time spent in
 * execute as the same blocks are called the most.
 *
 * With the help of the Blocks class create a mutable copy of block
 * information. The members of BlockCached derived values of block information
 * that does not need to be reevaluated until a change in Blocks. Since Blocks
 * handles where the cache instance is stored, it drops all cache versions of a
 * block when any change happens to it. This way we can quickly execute blocks
 * and keep perform the right action according to the current block information
 * in the editor.
 *
 * @param {Blocks} blockContainer the related Blocks instance
 * @param {object} cached default set of cached values
 */
class BlockCached {
    constructor (blockContainer, cached) {
        /**
         * Block id in its parent set of blocks.
         * @type {string}
         */
        this.id = cached.id;

        /**
         * Block operation code for this block.
         * @type {string}
         */
        this.opcode = cached.opcode;

        /**
         * Original block object containing argument values for static fields.
         * @type {object}
         */
        this.fields = cached.fields;

        /**
         * Original block object containing argument values for executable inputs.
         * @type {object}
         */
        this.inputs = cached.inputs;

        /**
         * Procedure mutation.
         * @type {?object}
         */
        this.mutation = cached.mutation;

        /**
         * Is the opcode a hat (event responder) block.
         * @type {boolean}
         */
        this._isHat = false;

        /**
         * The block opcode's implementation function.
         * @type {?function}
         */
        this._blockFunction = null;

        /**
         * Is the block function defined for this opcode?
         * @type {boolean}
         */
        this._definedBlockFunction = false;

        /**
         * Is this block a block with no function but a static value to return.
         * @type {boolean}
         */
        this._isShadowBlock = false;

        /**
         * The static value of this block if it is a shadow block.
         * @type {?any}
         */
        this._shadowValue = null;

        /**
         * A copy of the block's fields that may be modified.
         * @type {object}
         */
        this._fields = Object.assign({}, this.fields);

        /**
         * A copy of the block's inputs that may be modified.
         * @type {object}
         */
        this._inputs = Object.assign({}, this.inputs);

        /**
         * An arguments object for block implementations. All executions of this
         * specific block will use this objecct.
         * @type {object}
         */
        this._argValues = {
            mutation: this.mutation
        };

        /**
         * The inputs key the parent refers to this BlockCached by.
         * @type {string}
         */
        this._parentKey = null;

        /**
         * The target object where the parent wants the resulting value stored
         * with _parentKey as the key.
         * @type {object}
         */
        this._parentValues = null;

        /**
         * A sequence of shadow value operations that can be performed in any
         * order and are easier to perform given that they are static.
         * @type {Array<BlockCached>}
         */
        this._shadowOps = [];

        /**
         * A sequence of non-shadow operations that can must be performed. This
         * list recreates the order this block and its children are executed.
         * Since the order is always the same we can safely store that order
         * and iterate over the operations instead of dynamically walking the
         * tree every time.
         * @type {Array<BlockCached>}
         */
        this._ops = [];

        this._lastOperation = true;

        this.call = this.callGeneral;
        this.callProfile = this.callGeneralProfile;

        const {runtime} = blockUtility.sequencer;

        const {opcode, fields, inputs} = this;

        // Assign opcode isHat and blockFunction data to avoid dynamic lookups.
        this._isHat = runtime.getIsHat(opcode);
        this._blockFunction = runtime.getOpcodeFunction(opcode);
        this._definedBlockFunction = typeof this._blockFunction !== 'undefined';

        // Store the current shadow value if there is a shadow value.
        const fieldKeys = Object.keys(fields);
        this._isShadowBlock = (
            !this._definedBlockFunction &&
            fieldKeys.length === 1 &&
            Object.keys(inputs).length === 0
        );
        this._shadowValue = this._isShadowBlock && fields[fieldKeys[0]].value;

        // Store the static fields onto _argValues.
        for (const fieldName in fields) {
            if (
                fieldName === 'VARIABLE' ||
                fieldName === 'LIST' ||
                fieldName === 'BROADCAST_OPTION'
            ) {
                this._argValues[fieldName] = {
                    id: fields[fieldName].id,
                    name: fields[fieldName].value
                };
            } else {
                this._argValues[fieldName] = fields[fieldName].value;
            }
        }

        // Remove custom_block. It is not part of block execution.
        delete this._inputs.custom_block;

        if ('BROADCAST_INPUT' in this._inputs) {
            // BROADCAST_INPUT is called BROADCAST_OPTION in the args and is an
            // object with an unchanging shape.
            this._argValues.BROADCAST_OPTION = {
                id: null,
                name: null
            };

            // We can go ahead and compute BROADCAST_INPUT if it is a shadow
            // value.
            const broadcastInput = this._inputs.BROADCAST_INPUT;
            if (broadcastInput.block === broadcastInput.shadow) {
                // Shadow dropdown menu is being used.
                // Get the appropriate information out of it.
                const shadow = blockContainer.getBlock(broadcastInput.shadow);
                const broadcastField = shadow.fields.BROADCAST_OPTION;
                this._argValues.BROADCAST_OPTION.id = broadcastField.id;
                this._argValues.BROADCAST_OPTION.name = broadcastField.value;

                // Evaluating BROADCAST_INPUT here we do not need to do so
                // later.
                delete this._inputs.BROADCAST_INPUT;
            }
        }

        const valueKeys = Object.keys(this._argValues).concat(Object.keys(this._inputs));
        if (valueKeys.every(key => ['mutation', 'VARIABLE'].includes(key))) {
            this._argValues = new VariableValues(this._argValues);
        } else if (valueKeys.every(key => ['mutation', 'NUM1', 'NUM2'].includes(key))) {
            this._argValues = new Num2Values(this._argValues);
        } else if (valueKeys.every(key => ['mutation', 'NUM'].includes(key))) {
            this._argValues = new NumValues(this._argValues);
        } else if (valueKeys.every(key => ['mutation', 'OPERAND1', 'OPERAND2'].includes(key))) {
            this._argValues = new Operand2Values(this._argValues);
        } else if (valueKeys.every(key => ['mutation', 'CONDITION'].includes(key))) {
            this._argValues = new ConditionValues(this._argValues);
        }

        // Cache all input children blocks in the operation lists. The
        // operations can later be run in the order they appear in correctly
        // executing the operations quickly in a flat loop instead of needing to
        // recursivly iterate them.
        const childrenDefinitions = {};
        for (const inputName in this._inputs) {
            const input = this._inputs[inputName];
            if (input.block) {
                const inputCached = BlocksExecuteCache.getCached(blockContainer, input.block, BlockCached);

                if (inputCached._isHat) {
                    continue;
                }

                this._shadowOps.push(...inputCached._shadowOps);
                this._ops.push(...inputCached._ops);
                inputCached._parentKey = inputName;
                inputCached._parentValues = this._argValues;
                inputCached._lastOperation = false;

                // Shadow values are static and do not change, go ahead and
                // store their value on args.
                if (inputCached._isShadowBlock) {
                    if (this._blockFunction && this._blockFunction.defintion) {
                        if (this._blockFunction.defintion.defintion.arguments[inputName] instanceof BlockDefinition.Type.Number) {
                            this._argValues[inputName] = Cast.toNumber(inputCached._shadowValue);
                        } else {
                            this._argValues[inputName] = inputCached._shadowValue;
                        }
                    } else {
                        this._argValues[inputName] = inputCached._shadowValue;
                    }
                }

                childrenDefinitions[inputName] = inputCached._blockFunctionDefinition;


                if (inputCached._blockFunctionDefinition) {
                    if (inputCached._blockFunctionDefinition.threading.isSync()) {
                        if (inputName === 'BROADCAST_INPUT') {
                            inputCached.call = this.callSyncBROADCAST_INPUT;
                        } else {
                            inputCached.call = inputCached.genCallSync(inputCached._blockFunction);
                            inputCached.callProfile = inputCached.genCallSyncProfile(inputCached._blockFunction);
                        }
                    }
                }
            }
        }

        if (this._blockFunction && this._blockFunction.definition) {
            this._blockFunctionDefinition = this._blockFunction.definition(childrenDefinitions);

            for (const inputName in this._inputs) {
                const input = this._inputs[inputName];
                if (input.block) {
                    const inputCached = BlocksExecuteCache.getCached(blockContainer, input.block, BlockCached);

                    if (inputCached._blockFunctionDefinition) {
                        if (inputCached._blockFunctionDefinition.threading.isSync() && this._blockFunctionDefinition.arguments[inputName]) {
                            if (this._blockFunctionDefinition.arguments[inputName].mustCast()) {
                                if (this._blockFunctionDefinition.arguments[inputName].castNumber()) {
                                    inputCached.call = this.callSyncCastNumber;
                                    inputCached.callProfile = this.callSyncCastNumberProfile;
                                } else if (this._blockFunctionDefinition.arguments[inputName].castNan()) {
                                    inputCached.call = this.callSyncCastNan;
                                    inputCached.callProfile = this.callSyncCastNanProfile;
                                }
                            }
                        }
                    }
                }
            }
        }

        // The final operation is this block itself. At the top most block is a
        // command block or a block that is being run as a monitor.
        if (!this._isHat && this._isShadowBlock) {
            this._shadowOps.push(this);
        } else if (this._definedBlockFunction) {
            this._ops.push(this);
        }
    }

    callGeneral (sequencer, thread) {
        const blockFunction = this._blockFunction;

        // Update values for arguments (inputs).
        const argValues = this._argValues;

        const lastOperation = this._lastOperation;

        // Fields are set during this initialization.

        // Inputs are set during previous steps in the loop.

        const primitiveReportedValue = blockFunction(argValues, blockUtility);

        // If it's a promise, wait until promise resolves.
        if (isPromise(primitiveReportedValue)) {
            handlePromise(primitiveReportedValue, sequencer, thread, this, lastOperation);

            // We are waiting for a promise. Stop running this set of operations
            // and continue them later after thawing the reported values.
        } else if (thread.status === Thread.STATUS_RUNNING) {
            if (lastOperation) {
                handleReport(primitiveReportedValue, sequencer, thread, this, lastOperation);
            } else {
                // By definition a block that is not last in the list has a
                // parent.
                const inputName = this._parentKey;
                const parentValues = this._parentValues;

                if (inputName === 'BROADCAST_INPUT') {
                    // Something is plugged into the broadcast input.
                    // Cast it to a string. We don't need an id here.
                    parentValues.BROADCAST_OPTION.id = null;
                    parentValues.BROADCAST_OPTION.name = cast.toString(primitiveReportedValue);
                } else {
                    parentValues[inputName] = primitiveReportedValue;
                }
            }
        }
    }

    callGeneralProfile (sequencer, thread) {
        const blockFunction = this._blockFunction;

        // Update values for arguments (inputs).
        const argValues = this._argValues;

        const lastOperation = this._lastOperation;

        // Fields are set during this initialization.

        // Inputs are set during previous steps in the loop.

        const runtime = sequencer.runtime;
        // The method commented below has its code inlined
        // underneath to reduce the bias recorded for the profiler's
        // calls in this time sensitive execute function.
        //
        // runtime.profiler.start(blockFunctionProfilerId, opcode);
        runtime.profiler.records.push(
            runtime.profiler.START, blockFunctionProfilerId, this.opcode, performance.now());

        const primitiveReportedValue = blockFunction(argValues, blockUtility);

        // runtime.profiler.stop(blockFunctionProfilerId);
        runtime.profiler.records.push(runtime.profiler.STOP, performance.now());

        // If it's a promise, wait until promise resolves.
        if (isPromise(primitiveReportedValue)) {
            handlePromise(primitiveReportedValue, sequencer, thread, this, lastOperation);

            // We are waiting for a promise. Stop running this set of operations
            // and continue them later after thawing the reported values.
        } else if (thread.status === Thread.STATUS_RUNNING) {
            if (lastOperation) {
                handleReport(primitiveReportedValue, sequencer, thread, this, lastOperation);
            } else {
                // By definition a block that is not last in the list has a
                // parent.
                const inputName = this._parentKey;
                const parentValues = this._parentValues;

                if (inputName === 'BROADCAST_INPUT') {
                    // Something is plugged into the broadcast input.
                    // Cast it to a string. We don't need an id here.
                    parentValues.BROADCAST_OPTION.id = null;
                    parentValues.BROADCAST_OPTION.name = cast.toString(primitiveReportedValue);
                } else {
                    parentValues[inputName] = primitiveReportedValue;
                }
            }
        }
    }

    callPromise () {
        const blockFunction = this._blockFunction;

        // Update values for arguments (inputs).
        const argValues = this._argValues;

        const lastOperation = this._lastOperation;

        // Fields are set during this initialization.

        // Inputs are set during previous steps in the loop.

        const primitiveReportedValue = blockFunction(argValues, blockUtility);

        // If it's a promise, wait until promise resolves.
        handlePromise(primitiveReportedValue, sequencer, thread, this, lastOperation);

        // We are waiting for a promise. Stop running this set of operations
        // and continue them later after thawing the reported values.
    }

    callSyncLast () {
        const blockFunction = this._blockFunction;

        // Update values for arguments (inputs).
        const argValues = this._argValues;

        // Fields are set during this initialization.

        // Inputs are set during previous steps in the loop.

        const primitiveReportedValue = blockFunction(argValues, blockUtility);

        handleReport(primitiveReportedValue, sequencer, thread, this, lastOperation);
    }

    callSyncBROADCAST_INPUT () {
        const blockFunction = this._blockFunction;

        // Update values for arguments (inputs).
        const argValues = this._argValues;

        const lastOperation = this._lastOperation;

        // Fields are set during this initialization.

        // Inputs are set during previous steps in the loop.

        const primitiveReportedValue = blockFunction(argValues, blockUtility);

        // By definition a block that is not last in the list has a
        // parent.
        const parentValues = this._parentValues;

        // Something is plugged into the broadcast input.
        // Cast it to a string. We don't need an id here.
        parentValues.BROADCAST_OPTION.id = null;
        parentValues.BROADCAST_OPTION.name = cast.toString(primitiveReportedValue);
    }

    callSync () {
        // Fields are set during this initialization.

        // Inputs are set during previous steps in the loop.

        const primitiveReportedValue = this._blockFunction(this._argValues, blockUtility);

        // By definition a block that is not last in the list has a
        // parent.
        this._parentValues[this._parentKey] = primitiveReportedValue;
    }

    callSyncCastNumber () {
        // Fields are set during this initialization.

        // Inputs are set during previous steps in the loop.

        const primitiveReportedValue = this._blockFunction(this._argValues, blockUtility);

        // By definition a block that is not last in the list has a
        // parent.
        this._parentValues[this._parentKey] = cast.toNumber(primitiveReportedValue);
    }

    callSyncCastNan () {
        // Fields are set during this initialization.

        // Inputs are set during previous steps in the loop.

        const primitiveReportedValue = this._blockFunction(this._argValues, blockUtility);

        // By definition a block that is not last in the list has a
        // parent.
        this._parentValues[this._parentKey] = isNaN(primitiveReportedValue) ? 0 : primitiveReportedValue;
    }

    genCallSync (blockFunction) {
        if (!BlockCached.callByOpcode.has(blockFunction)) {
            BlockCached.callByOpcode.set(blockFunction, function () {
                // Fields are set during this initialization.

                // Inputs are set during previous steps in the loop.

                const primitiveReportedValue = blockFunction(this._argValues, blockUtility);

                // By definition a block that is not last in the list has a
                // parent.
                this._parentValues[this._parentKey] = primitiveReportedValue;
            });
        }

        return BlockCached.callByOpcode.get(blockFunction);
    }

    callSyncProfile (sequencer, thread) {
        // Fields are set during this initialization.

        // Inputs are set during previous steps in the loop.

        const runtime = sequencer.runtime;
        // The method commented below has its code inlined
        // underneath to reduce the bias recorded for the profiler's
        // calls in this time sensitive execute function.
        //
        // runtime.profiler.start(blockFunctionProfilerId, opcode);
        runtime.profiler.records.push(
            runtime.profiler.START, blockFunctionProfilerId, this.opcode, performance.now());

        const primitiveReportedValue = this._blockFunction(this._argValues, blockUtility);

        // runtime.profiler.stop(blockFunctionProfilerId);
        runtime.profiler.records.push(runtime.profiler.STOP, performance.now());

        // By definition a block that is not last in the list has a
        // parent.
        this._parentValues[this._parentKey] = primitiveReportedValue;
    }

    callSyncCastNumberProfile (sequencer, thread) {
        // Fields are set during this initialization.

        // Inputs are set during previous steps in the loop.

        const runtime = sequencer.runtime;
        // The method commented below has its code inlined
        // underneath to reduce the bias recorded for the profiler's
        // calls in this time sensitive execute function.
        //
        // runtime.profiler.start(blockFunctionProfilerId, opcode);
        runtime.profiler.records.push(
            runtime.profiler.START, blockFunctionProfilerId, this.opcode, performance.now());

        const primitiveReportedValue = this._blockFunction(this._argValues, blockUtility);

        // runtime.profiler.stop(blockFunctionProfilerId);
        runtime.profiler.records.push(runtime.profiler.STOP, performance.now());

        // By definition a block that is not last in the list has a
        // parent.
        this._parentValues[this._parentKey] = cast.toNumber(primitiveReportedValue);
    }

    callSyncCastNanProfile (sequencer, thread) {
        // Fields are set during this initialization.

        // Inputs are set during previous steps in the loop.

        const runtime = sequencer.runtime;
        // The method commented below has its code inlined
        // underneath to reduce the bias recorded for the profiler's
        // calls in this time sensitive execute function.
        //
        // runtime.profiler.start(blockFunctionProfilerId, opcode);
        runtime.profiler.records.push(
            runtime.profiler.START, blockFunctionProfilerId, this.opcode, performance.now());

        const primitiveReportedValue = this._blockFunction(this._argValues, blockUtility);

        // runtime.profiler.stop(blockFunctionProfilerId);
        runtime.profiler.records.push(runtime.profiler.STOP, performance.now());

        // By definition a block that is not last in the list has a
        // parent.
        this._parentValues[this._parentKey] = isNaN(primitiveReportedValue) ? 0 : primitiveReportedValue;
    }

    genCallSyncProfile (blockFunction) {
        if (!BlockCached.callProfileByOpcode.has(blockFunction)) {
            BlockCached.callProfileByOpcode.set(blockFunction, function (sequencer, thread) {
                // Fields are set during this initialization.

                // Inputs are set during previous steps in the loop.

                const runtime = sequencer.runtime;
                if (blockFunctionProfilerId === -1) {
                    blockFunctionProfilerId = runtime.profiler.idByName(blockFunctionProfilerFrame);
                }
                // The method commented below has its code inlined
                // underneath to reduce the bias recorded for the profiler's
                // calls in this time sensitive execute function.
                //
                // runtime.profiler.start(blockFunctionProfilerId, opcode);
                runtime.profiler.records.push(
                    runtime.profiler.START, blockFunctionProfilerId, this.opcode, performance.now());

                const primitiveReportedValue = blockFunction(this._argValues, blockUtility);

                // runtime.profiler.stop(blockFunctionProfilerId);
                runtime.profiler.records.push(runtime.profiler.STOP, performance.now());

                // By definition a block that is not last in the list has a
                // parent.
                this._parentValues[this._parentKey] = primitiveReportedValue;
            });
        }

        return BlockCached.callProfileByOpcode.get(blockFunction);
    }

    genCallSyncSetter (blockFunction, inputName) {
        if (!BlockCached.callByOpcodeAndSetter.has(blockFunction)) {
            BlockCached.callByOpcodeAndSetter.set(blockFunction, new window.Map());
        }
        if (!BlockCached.callByOpcodeAndSetter.get(blockFunction).has(inputName)) {
            const built = new Function('blockFunction', 'blockUtility', `return function () {
                // Update values for arguments (inputs).
                const argValues = this._argValues;

                // Fields are set during this initialization.

                // Inputs are set during previous steps in the loop.

                const primitiveReportedValue = blockFunction(argValues, blockUtility);

                // By definition a block that is not last in the list has a
                // parent.
                const parentValues = this._parentValues;

                parentValues.${inputName} = primitiveReportedValue;
            }`)(blockFunction, blockUtility);
            BlockCached.callByOpcodeAndSetter.get(blockFunction).set(inputName, built);
        }

        return BlockCached.callByOpcodeAndSetter.get(blockFunction).get(inputName);
    }

    genCallSyncSetterProfile (blockFunction, inputName) {
        if (!BlockCached.callProfileByOpcodeAndSetter.has(blockFunction)) {
            BlockCached.callProfileByOpcodeAndSetter.set(blockFunction, new window.Map());
        }
        if (!BlockCached.callProfileByOpcodeAndSetter.get(blockFunction).has(inputName)) {
            BlockCached.callProfileByOpcodeAndSetter.get(blockFunction).set(inputName, new Function('blockFunction', 'blockUtility', 'blockFunctionProfilerFrame', `let blockFunctionProfilerId = -1;
            return function (sequencer, thread) {
                // Update values for arguments (inputs).
                const argValues = this._argValues;

                // Fields are set during this initialization.

                // Inputs are set during previous steps in the loop.

                const runtime = sequencer.runtime;
                const opcode = this.opcode;
                if (blockFunctionProfilerId === -1) {
                    blockFunctionProfilerId = runtime.profiler.idByName(blockFunctionProfilerFrame);
                }
                // The method commented below has its code inlined
                // underneath to reduce the bias recorded for the profiler's
                // calls in this time sensitive execute function.
                //
                // runtime.profiler.start(blockFunctionProfilerId, opcode);
                runtime.profiler.records.push(
                    runtime.profiler.START, blockFunctionProfilerId, opcode, performance.now());

                const primitiveReportedValue = blockFunction(argValues, blockUtility);

                // runtime.profiler.stop(blockFunctionProfilerId);
                runtime.profiler.records.push(runtime.profiler.STOP, performance.now());

                // By definition a block that is not last in the list has a
                // parent.
                const parentValues = this._parentValues;

                parentValues.${inputName} = primitiveReportedValue;
            }`)(blockFunction, blockUtility, blockFunctionProfilerFrame));
        }

        return BlockCached.callProfileByOpcodeAndSetter.get(blockFunction).get(inputName);
    }
}

BlockCached.callByOpcode = new window.Map();
BlockCached.callProfileByOpcode = new window.Map();
BlockCached.callByOpcodeAndSetter = new window.Map();
BlockCached.callProfileByOpcodeAndSetter = new window.Map();

BlockCached.callByOpcode.set('NUM1', function () {
    const blockFunction = this._blockFunction;

    // Update values for arguments (inputs).
    const argValues = this._argValues;

    const lastOperation = this._lastOperation;

    // Fields are set during this initialization.

    // Inputs are set during previous steps in the loop.

    const primitiveReportedValue = blockFunction(argValues, blockUtility);

    // By definition a block that is not last in the list has a
    // parent.
    const parentValues = this._parentValues;

    parentValues.NUM1 = primitiveReportedValue;
});

BlockCached.callProfileByOpcode.set('NUM1', function (sequencer) {
    const blockFunction = this._blockFunction;

    // Update values for arguments (inputs).
    const argValues = this._argValues;

    const lastOperation = this._lastOperation;

    // Fields are set during this initialization.

    // Inputs are set during previous steps in the loop.

    const runtime = sequencer.runtime;
    const opcode = this.opcode;
    if (blockFunctionProfilerId === -1) {
        blockFunctionProfilerId = runtime.profiler.idByName(blockFunctionProfilerFrame);
    }
    // The method commented below has its code inlined
    // underneath to reduce the bias recorded for the profiler's
    // calls in this time sensitive execute function.
    //
    // runtime.profiler.start(blockFunctionProfilerId, opcode);
    runtime.profiler.records.push(
        runtime.profiler.START, blockFunctionProfilerId, opcode, performance.now());

    const primitiveReportedValue = blockFunction(argValues, blockUtility);

    // runtime.profiler.stop(blockFunctionProfilerId);
    runtime.profiler.records.push(runtime.profiler.STOP, performance.now());

    // By definition a block that is not last in the list has a
    // parent.
    const parentValues = this._parentValues;

    parentValues.NUM1 = primitiveReportedValue;
});

BlockCached.callByOpcode.set('NUM2', function () {
    const blockFunction = this._blockFunction;

    // Update values for arguments (inputs).
    const argValues = this._argValues;

    const lastOperation = this._lastOperation;

    // Fields are set during this initialization.

    // Inputs are set during previous steps in the loop.

    const primitiveReportedValue = blockFunction(argValues, blockUtility);

    // By definition a block that is not last in the list has a
    // parent.
    const parentValues = this._parentValues;

    parentValues.NUM2 = primitiveReportedValue;
});

BlockCached.callProfileByOpcode.set('NUM2', function (sequencer) {
    const blockFunction = this._blockFunction;

    // Update values for arguments (inputs).
    const argValues = this._argValues;

    const lastOperation = this._lastOperation;

    // Fields are set during this initialization.

    // Inputs are set during previous steps in the loop.

    const runtime = sequencer.runtime;
    const opcode = this.opcode;
    if (blockFunctionProfilerId === -1) {
        blockFunctionProfilerId = runtime.profiler.idByName(blockFunctionProfilerFrame);
    }
    // The method commented below has its code inlined
    // underneath to reduce the bias recorded for the profiler's
    // calls in this time sensitive execute function.
    //
    // runtime.profiler.start(blockFunctionProfilerId, opcode);
    runtime.profiler.records.push(
        runtime.profiler.START, blockFunctionProfilerId, opcode, performance.now());

    const primitiveReportedValue = blockFunction(argValues, blockUtility);

    // runtime.profiler.stop(blockFunctionProfilerId);
    runtime.profiler.records.push(runtime.profiler.STOP, performance.now());

    // By definition a block that is not last in the list has a
    // parent.
    const parentValues = this._parentValues;

    parentValues.NUM2 = primitiveReportedValue;
});

/**
 * Execute a block.
 * @param {!Sequencer} sequencer Which sequencer is executing.
 * @param {!Thread} thread Thread which to read and execute.
 */
const execute = function (sequencer, thread) {
    const runtime = sequencer.runtime;

    // store sequencer and thread so block functions can access them through
    // convenience methods.
    blockUtility.sequencer = sequencer;
    blockUtility.thread = thread;

    // Current block to execute is the one on the top of the stack.
    const currentBlockId = thread.peekStack();
    const currentStackFrame = thread.peekStackFrame();

    let blockContainer = thread.blockContainer;
    let blockCached = BlocksExecuteCache.getCached(blockContainer, currentBlockId, BlockCached);
    if (blockCached === null) {
        blockContainer = runtime.flyoutBlocks;
        blockCached = BlocksExecuteCache.getCached(blockContainer, currentBlockId, BlockCached);
        // Stop if block or target no longer exists.
        if (blockCached === null) {
            // No block found: stop the thread; script no longer exists.
            sequencer.retireThread(thread);
            return;
        }
    }

    const ops = blockCached._ops;
    const length = ops.length;
    let i = 0;

    if (currentStackFrame.reported !== null) {
        const reported = currentStackFrame.reported;
        // Reinstate all the previous values.
        for (; i < reported.length; i++) {
            const {opCached: oldOpCached, inputValue} = reported[i];

            const opCached = ops.find(op => op.id === oldOpCached);

            if (opCached) {
                const inputName = opCached._parentKey;
                const argValues = opCached._parentValues;

                if (inputName === 'BROADCAST_INPUT') {
                    // Something is plugged into the broadcast input.
                    // Cast it to a string. We don't need an id here.
                    argValues.BROADCAST_OPTION.id = null;
                    argValues.BROADCAST_OPTION.name = cast.toString(inputValue);
                } else {
                    argValues[inputName] = inputValue;
                }
            }
        }

        // Find the last reported block that is still in the set of operations.
        // This way if the last operation was removed, we'll find the next
        // candidate. If an earlier block that was performed was removed then
        // we'll find the index where the last operation is now.
        if (reported.length > 0) {
            const lastExisting = reported.reverse().find(report => ops.find(op => op.id === report.opCached));
            if (lastExisting) {
                i = ops.findIndex(opCached => opCached.id === lastExisting.opCached) + 1;
            } else {
                i = 0;
            }
        }

        // The reporting block must exist and must be the next one in the sequence of operations.
        if (thread.justReported !== null && ops[i] && ops[i].id === currentStackFrame.reporting) {
            const opCached = ops[i];
            const inputValue = thread.justReported;

            thread.justReported = null;

            const inputName = opCached._parentKey;
            const argValues = opCached._parentValues;

            if (inputName === 'BROADCAST_INPUT') {
                // Something is plugged into the broadcast input.
                // Cast it to a string. We don't need an id here.
                argValues.BROADCAST_OPTION.id = null;
                argValues.BROADCAST_OPTION.name = cast.toString(inputValue);
            } else {
                argValues[inputName] = inputValue;
            }

            i += 1;
        }

        currentStackFrame.reporting = null;
        currentStackFrame.reported = null;
    }

    // for (; i < length; i++) {
    //     const lastOperation = i === length - 1;
    //     const opCached = ops[i];
    //
    //     const blockFunction = opCached._blockFunction;
    //
    //     // Update values for arguments (inputs).
    //     const argValues = opCached._argValues;
    //
    //     // Fields are set during opCached initialization.
    //
    //     // Blocks should glow when a script is starting,
    //     // not after it has finished (see #1404).
    //     // Only blocks in blockContainers that don't forceNoGlow
    //     // should request a glow.
    //     if (!blockContainer.forceNoGlow) {
    //         thread.requestScriptGlowInFrame = true;
    //     }
    //
    //     // Inputs are set during previous steps in the loop.
    //
    //     let primitiveReportedValue = null;
    //     if (runtime.profiler === null) {
    //         primitiveReportedValue = blockFunction(argValues, blockUtility);
    //     } else {
    //         const opcode = opCached.opcode;
    //         if (blockFunctionProfilerId === -1) {
    //             blockFunctionProfilerId = runtime.profiler.idByName(blockFunctionProfilerFrame);
    //         }
    //         // The method commented below has its code inlined
    //         // underneath to reduce the bias recorded for the profiler's
    //         // calls in this time sensitive execute function.
    //         //
    //         // runtime.profiler.start(blockFunctionProfilerId, opcode);
    //         runtime.profiler.records.push(
    //             runtime.profiler.START, blockFunctionProfilerId, opcode, 0);
    //
    //         primitiveReportedValue = blockFunction(argValues, blockUtility);
    //
    //         // runtime.profiler.stop(blockFunctionProfilerId);
    //         runtime.profiler.records.push(runtime.profiler.STOP, 0);
    //     }
    //
    //     // If it's a promise, wait until promise resolves.
    //     if (isPromise(primitiveReportedValue)) {
    //         handlePromise(primitiveReportedValue, sequencer, thread, opCached, lastOperation);
    //
    //         // Store the already reported values. They will be thawed into the
    //         // future versions of the same operations by block id. The reporting
    //         // operation if it is promise waiting will set its parent value at
    //         // that time.
    //         thread.justReported = null;
    //         currentStackFrame.reporting = ops[i].id;
    //         currentStackFrame.reported = ops.slice(0, i).map(reportedCached => {
    //             const inputName = reportedCached._parentKey;
    //             const reportedValues = reportedCached._parentValues;
    //
    //             if (inputName === 'BROADCAST_INPUT') {
    //                 return {
    //                     opCached: reportedCached.id,
    //                     inputValue: reportedValues[inputName].BROADCAST_OPTION.name
    //                 };
    //             }
    //             return {
    //                 opCached: reportedCached.id,
    //                 inputValue: reportedValues[inputName]
    //             };
    //         });
    //
    //         // We are waiting for a promise. Stop running this set of operations
    //         // and continue them later after thawing the reported values.
    //         break;
    //     } else if (thread.status === Thread.STATUS_RUNNING) {
    //         if (lastOperation) {
    //             handleReport(primitiveReportedValue, sequencer, thread, opCached, lastOperation);
    //         } else {
    //             // By definition a block that is not last in the list has a
    //             // parent.
    //             const inputName = opCached._parentKey;
    //             const parentValues = opCached._parentValues;
    //
    //             if (inputName === 'BROADCAST_INPUT') {
    //                 // Something is plugged into the broadcast input.
    //                 // Cast it to a string. We don't need an id here.
    //                 parentValues.BROADCAST_OPTION.id = null;
    //                 parentValues.BROADCAST_OPTION.name = cast.toString(primitiveReportedValue);
    //             } else {
    //                 parentValues[inputName] = primitiveReportedValue;
    //             }
    //         }
    //     }
    // }

    if (runtime.profiler === null) {
        for (; i < length && thread.status === Thread.STATUS_RUNNING; i++) {
            ops[i].call(sequencer, thread);
        }
    } else {
        if (blockFunctionProfilerId === -1) {
            blockFunctionProfilerId = runtime.profiler.idByName(blockFunctionProfilerFrame);
        }

        for (; i < length && thread.status === Thread.STATUS_RUNNING; i++) {
            ops[i].callProfile(sequencer, thread);
        }
    }

    if (thread.status === Thread.STATUS_PROMISE_WAIT) {
        i -= 1;

        // Store the already reported values. They will be thawed into the
        // future versions of the same operations by block id. The reporting
        // operation if it is promise waiting will set its parent value at
        // that time.
        thread.justReported = null;
        currentStackFrame.reporting = ops[i].id;
        currentStackFrame.reported = ops.slice(0, i).map(reportedCached => {
            const inputName = reportedCached._parentKey;
            const reportedValues = reportedCached._parentValues;

            if (inputName === 'BROADCAST_INPUT') {
                return {
                    opCached: reportedCached.id,
                    inputValue: reportedValues[inputName].BROADCAST_OPTION.name
                };
            }
            return {
                opCached: reportedCached.id,
                inputValue: reportedValues[inputName]
            };
        });
    }
};

module.exports = execute;
