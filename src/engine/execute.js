const BlockUtility = require('./block-utility');
const BlocksExecuteCache = require('./blocks-execute-cache');
const log = require('../util/log');
const Thread = require('./thread');
const Profiler = require('./profiler');
const Cast = require('../util/cast');

/**
 * Thread status value when it is actively running.
 * @const {number}
 */
const STATUS_RUNNING = 0; // Thread.STATUS_RUNNING

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
        // Most values will be strings, numbers and booleans. Since they are not
        // objects test that first to shortcut out of isPromise as quickly as
        // possible.
        typeof value === 'object' &&
        // Strings, numbers, and booleans are not null, so this test will be
        // true for most values. Test this after testing if its an object to
        // shortcut isPromise faster.
        value !== null &&
        // At this point it is very likely value is a promise, check if it has a
        // then to at least determine it is a thenable. We can't exhaustiviely
        // test if value is a promise since promises are an interface and not a
        // specific type.
        typeof value.then === 'function'
    );
};

const call = function (opCached) {
    return opCached._parentValues[opCached._parentKey] = (
        opCached._blockFunctionUnbound.call(
            opCached._blockFunctionContext,
            opCached._argValues, blockUtility
        ));
};

const wrapPromise = function (value) {
    if (isPromise(value)) blockUtility.thread.status = Thread.STATUS_PROMISE_WAIT;
};

/**
 * Handle any reported value from the primitive, either directly returned
 * or after a promise resolves.
 * @param {*} reportedValue Value eventually returned from the primitive.
 * @param {!Thread} thread Thread containing the primitive.
 * @param {!string} blockCached cached block of data used by execute.
 */
const handlePromise = (thread, blockCached) => {
    const reportedValue = blockCached._parentValues[blockCached._parentKey];

    if (thread.status === STATUS_RUNNING) {
        // Primitive returned a promise; automatically yield thread.
        thread.status = Thread.STATUS_PROMISE_WAIT;
    }

    // Promise handlers
    reportedValue.then(resolvedValue => {
        thread.pushReportedValue(resolvedValue);
        thread.status = STATUS_RUNNING;
        thread.pushStack('vm_reenter_promise');
    }, rejectionReason => {
        // Promise rejected: the primitive had some error. Log it and proceed.
        log.warn('Primitive rejected promise: ', rejectionReason);
        thread.status = STATUS_RUNNING;
        thread.popStack();
    });

    // Store the already reported values. They will be thawed into the
    // future versions of the same operations by block id. The reporting
    // operation if it is promise waiting will set its parent value at
    // that time.
    thread.justReported = null;
    const ops = blockCached._ops;
    thread.reporting = blockCached.id;
    thread.reported = ops.slice(0, ops.indexOf(blockCached)).map(reportedCached => {
        const inputName = reportedCached._parentKey;
        const reportedValues = reportedCached._parentValues;
        return {
            opCached: reportedCached.id,
            inputValue: reportedValues[inputName]
        };
    });
};

const safeId = function (id) {
    id = String(id);
    let hash = 0x00000000;
    for (let i = 0; i < id.length; i++) {
        hash = Math.abs(((hash << 5) - hash + id.charCodeAt(i)) & 0xffffffff);
        // hash = Math.abs((
        //     hash + (id.charCodeAt(i) * Math.pow(31, id.length - i - 1))
        // ) & 0xffffffff);
    }
    return `_${Math.abs(hash)}`;
};

const safe32Chars = '_abcdefghijklmnopqrstuvwxyzABCDE'.split('');
const safe64Chars = '_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$'.split('');
const safe64 = function (id) {
    let s = '';
    id = id | 0;

    while (id > 0x1f) {
        s = safe64Chars[id & 0x3f] + s;
        id = id >> 6;
    }
    s = safe32Chars[id & 0x1f] + s;
    return s;
};

// 13 1
// 1 * 32 + 13

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
        this.blockContainer = blockContainer;

        /**
         * Block id in its parent set of blocks.
         * @type {string}
         */
        this.id = cached.id;

        this.ref = cached.ref;

        this._safeId = safeId(cached.id);

        this.index = cached.index;

        /**
         * Block operation code for this block.
         * @type {string}
         */
        this.opcode = cached.opcode;

        this.profiler = 0;

        /**
         * Some opcodes (vm_*) should not be measured by the profiler.
         * @type {boolean}
         */
        this.profileOpcode = !cached.opcode.startsWith('vm_');

        this.profilerFrame = Profiler.NULL_FRAME;

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
         * The block opcode function before being self-bound.
         * @type {?function}
         */
        this._blockFunctionUnbound = null;

        /**
         * The bound block opcode context.
         * @type {?object}
         */
        this._blockFunctionContext = null;

        /**
         * Is the block function defined for this opcode?
         * @type {boolean}
         */
        this._definedBlockFunction = false;

        this._usesPromise = false;

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

        this._parentId = '';

        this._parentOffset = 0;

        this._parentSafeId = '';

        this._parentOpcode = '';

        /**
         * The inputs key the parent refers to this BlockCached by.
         * @type {string}
         */
        this._parentKey = 'STATEMENT';

        /**
         * The target object where the parent wants the resulting value stored
         * with _parentKey as the key.
         * @type {object}
         */
        this._parentValues = {};

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

        this._next = null;
        this._allOps = this._ops;

        this.count = 0;

        this.willCount = [];
        this.mayCount = [];
        this.opsAt = 0;
        this.opsAfter = 0;
    }
}

class MayCount {
    constructor ({opcode, frame, may}) {
        this.opcode = opcode;
        this.frame = frame;
        this.count = 0;
        this.may = (may | 0) + 1;
    }
}
const callPromise = function () {
    const cache = {};
    return function (opcode, _blockFunction, _this) {
        _this._usesPromise = cache[opcode] !== _blockFunction;
        return cache[opcode] || (
            function (args, blockUtility) {
                if (cache[opcode]) {
                    _this._usesPromise = cache[opcode] !== _blockFunction;
                    _this._blockFunction = cache[opcode];
                    return _this._blockFunction(args, blockUtility);
                }
                const value = _blockFunction(args, blockUtility);
                if (isPromise(value)) {
                    blockUtility.thread.status = Thread.STATUS_PROMISE_WAIT;
                    cache[opcode] = _this._blockFunction = function (args, blockUtility) {
                        blockUtility.thread.status = Thread.STATUS_PROMISE_WAIT;
                        return _blockFunction(args, blockUtility);
                    };
                } else {
                    _this._usesPromise = false;
                    cache[opcode] = _this._blockFunction = _blockFunction;
                }
                return value;
            }
        );
    };
}();
const functionDataCache = {};
class InputBlockCached extends BlockCached {
    constructor (blockContainer, cached) {
        super(blockContainer, cached);

        const {runtime} = blockUtility.sequencer;

        const {opcode, fields, inputs} = this;

        // Assign opcode isHat and blockFunction data to avoid dynamic lookups.
        this._isHat = runtime.getIsHat(opcode);
        const _blockFunction = runtime.getOpcodeFunction(opcode);
        this._definedBlockFunction = typeof _blockFunction === 'function';
        if (this._definedBlockFunction) {
            // If available, save the unbound function. It's faster to
            // unbound.call(context) than to call unbound.bind(context)().
            this._blockFunctionUnbound = _blockFunction._function || _blockFunction;
            this._blockFunctionContext = _blockFunction._context;
            let functionData = functionDataCache[opcode];
            if (!functionData) {
                const source = this._blockFunctionUnbound.toString();
                const needsContext = source.indexOf('this') > -1;
                functionData = functionDataCache[opcode] = {
                    opcode,
                    source,
                    needsContext,
                    function: needsContext ?
                        _blockFunction :
                        (_blockFunction._function || _blockFunction)
                };
            }
            this._blockFunction = callPromise(opcode, functionData.function, this);
        }

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

        // Cache all input children blocks in the operation lists. The
        // operations can later be run in the order they appear in correctly
        // executing the operations quickly in a flat loop instead of needing to
        // recursivly iterate them.
        for (const inputName in this._inputs) {
            const input = this._inputs[inputName];
            if (input.block && inputName === 'BROADCAST_INPUT') {
                // We can use a vm_* block to cast to a string and save it where
                // it would normally be placed. This lets us produce this value
                // dynamically without having special case handling later in the
                // runtime execute function.
                const inputCached = new InputBlockCached(runtime.sequencer.blocks, {
                    id: input.block,
                    opcode: 'vm_cast_string',
                    fields: {},
                    inputs: {
                        VALUE: {
                            block: input.block,
                            shadow: null
                        }
                    },
                    mutation: null
                });

                this._shadowOps.unshift(...inputCached._shadowOps);
                this._ops.unshift(...inputCached._ops);
                inputCached._parentKey = 'name';
                inputCached._parentValues = this._argValues.BROADCAST_OPTION;
            } else if (input.block) {
                const inputCached = BlocksExecuteCache.getCached(blockContainer, input.block, InputBlockCached);

                if (inputCached._isHat) {
                    continue;
                }

                inputCached._parentOffset = this._ops.length + 1;
                this._shadowOps.unshift(...inputCached._shadowOps);
                this._ops.unshift(...inputCached._ops);
                inputCached._parentId = this.id;
                inputCached._parentSafeId = this._safeId;
                inputCached._parentOpcode = this.opcode;
                inputCached._parentKey = inputName;
                inputCached._parentValues = this._argValues;

                // Shadow values are static and do not change, go ahead and
                // store their value on args.
                if (inputCached._isShadowBlock) {
                    let shadowValue = inputCached._shadowValue;
                    if (typeof shadowValue === 'string' &&
                        Cast.toNumber(shadowValue).toString() === shadowValue.trim()) {
                        shadowValue = Cast.toNumber(shadowValue);
                    } else if (typeof shadowValue === 'number') {
                        shadowValue = Cast.toNumber(shadowValue);
                    }
                    this._argValues[inputName] = shadowValue;
                } else {
                    // this._argValues[inputName] = 0;
                }
            } else {
                // this._argValues[inputName] = 0;
            }
        }

        // const _ops = this._ops.slice();
        // this._ops.sort((a, b) => (
        //     (this._argValues === b._parentValues ? _ops.length :
        //         _ops.findIndex(_b => _b._argValues === b._parentValues)) -
        //     (this._argValues === a._parentValues ? _ops.length :
        //         _ops.findIndex(_a => _a._argValues === a._parentValues))
        // ));

        // The final operation is this block itself. At the top most block is a
        // command block or a block that is being run as a monitor.
        if (!this._isHat && this._isShadowBlock) {
            this._shadowOps.push(this);
        } else if (this._definedBlockFunction) {
            this._ops.push(this);

            if (this._isHat) {
                const reportCached = new InputBlockCached(null, {
                    id: cached.id,
                    opcode: 'vm_report_hat',
                    fields: {},
                    inputs: {},
                    mutation: null
                });

                this._ops = [...this._ops, ...reportCached._ops];
                this._parentKey = 'VALUE';
                this._parentValues = reportCached._argValues;
            }
        }

        this._next = null;
        this._allOps = this._ops;
    }

    handlePromise () {
        handlePromise(blockUtility.thread, this);
    }
}

class CommandBlockCached extends InputBlockCached {
    constructor (blockContainer, cached) {
        super(blockContainer, cached);
    }

    setup () {
        const {blockContainer} = this;

        if (/^vm_end/.test(this.id)) {
            this._argValues.NEXT_PARENT = {NEXT: null};
        }

        if (this.opcode === 'procedures_call') {
            const procedureInfo = blockContainer.getProcedureInfo(this._argValues.mutation.proccode);
            const {paramIds, paramDefaults} = procedureInfo;
            for (let p = 0; p < paramIds.length; p++) {
                if (typeof this._argValues[paramIds[p]] === 'undefined') {
                    this._argValues[paramIds[p]] = paramDefaults[p];
                }
            }
        }

        const nextId = blockContainer ?
            blockContainer.getNextBlock(this.id) :
            null;
        const nextCached = blockContainer ? BlocksExecuteCache.getCached(
            blockContainer, nextId, CommandBlockCached
        ) : null;

        this._next = nextCached;

        const NEXT_PARENT = {NEXT: null};

        const mayContinueCached = new InputBlockCached(null, {
            id: this.id,
            opcode: 'vm_may_continue',
            fields: {},
            inputs: {},
            mutation: null
        });
        mayContinueCached._argValues = {
            END_FUNCTION: null,
            END_OPERATION: '',
            EXPECT_STACK: this.id,
            NEXT_STACK: nextId,
            NEXT_BLOCK: nextCached,
            NEXT_PARENT,
            NEXT_INDEX: nextCached ? nextCached.index : -1
        };
        let followUpCached = mayContinueCached;

        const substack1 = blockContainer.getBranch(this.id, 1);
        const substack2 = blockContainer.getBranch(this.id, 2);

        if (substack1) {
            if (substack2) {
                const substack2Cached = new InputBlockCached(null, {
                    id: this.id,
                    opcode: 'vm_do_stack',
                    fields: {},
                    inputs: {},
                    mutation: null
                });
                substack2Cached._argValues = {
                    END_FUNCTION: null,
                    END_OPERATION: '',
                    // GET_BLOCK: () => {
                    //     return substack2Cached._argValues.BLOCK_CACHED = getCached(blockUtility.thread, -1, substack2)._commandSet.firstCommand;
                    // },
                    // BLOCK_CACHED: null,
                    BLOCK_CACHED: _getCached(blockUtility.thread, substack2),
                    ELSE_CACHED: followUpCached,
                    NEXT_STACK: nextId,
                    NEXT_PARENT
                };
                followUpCached = substack2Cached;
            }

            if (substack1) {
                const substack1Cached = new InputBlockCached(null, {
                    id: this.id,
                    opcode: 'vm_do_stack',
                    fields: {},
                    inputs: {},
                    mutation: null
                });
                substack1Cached._argValues = {
                    END_FUNCTION: null,
                    END_OPERATION: '',
                    // GET_BLOCK: () => {
                    //     return substack1Cached._argValues.BLOCK_CACHED = getCached(blockUtility.thread, -1, substack1)._commandSet.firstCommand;
                    // },
                    // BLOCK_CACHED: null,
                    BLOCK_CACHED: _getCached(blockUtility.thread, substack1),
                    ELSE_CACHED: followUpCached,
                    NEXT_STACK: nextId,
                    NEXT_PARENT
                };
                followUpCached = substack1Cached;
            }
        }

        if (this.opcode === 'procedures_call') {
            const proccode = this._argValues.mutation.proccode;
            const thread = blockUtility.thread;
            const definition = thread.blockContainer.getProcedureDefinition(proccode);

            const procedureCached = new InputBlockCached(null, {
                id: this.id,
                opcode: 'vm_do_stack',
                fields: {},
                inputs: {},
                mutation: null
            });
            procedureCached._argValues = {
                END_FUNCTION: null,
                END_OPERATION: '',
                // GET_BLOCK: () => {
                //     return procedureCached._argValues.BLOCK_CACHED = getCached(blockUtility.thread, -1, definition)._commandSet.firstCommand;
                // },
                // BLOCK_CACHED: null,
                BLOCK_CACHED: _getCached(blockUtility.thread, definition),
                ELSE_CACHED: followUpCached,
                NEXT_STACK: nextId,
                NEXT_PARENT
            };
            followUpCached = procedureCached;
        }

        this.NEXT_PARENT = NEXT_PARENT;
        if (nextCached !== null) {
            this.NEXT_PARENT = nextCached._ops[nextCached._ops.length - 1]._argValues.NEXT_PARENT;
        }

        this._ops.push(followUpCached);
        this._allOps = [
            ...this._ops,
            ...(nextCached ? nextCached._allOps : [])
        ];

        this._commandSet = {i: 0, firstCommand: this};
        for (let i = 0; i < this._allOps.length; i++) {
            this._allOps[i]._commandSet = {i: this._allOps.indexOf(this._allOps[i]._ops[0]), firstCommand: this};
        }

        this.ref._next = nextCached || NULL_BLOCK;
        this.ref._branches = [substack1, substack2].map(id => id ? _getCached(blockUtility.thread, id) : NULL_BLOCK);
    }

    compile () {
        compile(this);
    }
}

class NullBlockCached extends BlockCached {
    constructor (blockContainer, cached) {
        super(blockContainer, cached);

        this._blockFunction = this._blockFunctionUnbound =
            function (_, {sequencer, thread}) {
                sequencer.retireThread(thread);
            };
        this._definedBlockFunction = true;
        this._ops.push(this);
    }
}

const NULL_BLOCK = new NullBlockCached(null, {
    id: null,
    opcode: 'vm_null',
    fields: {},
    inputs: {},
    mutation: null
});

const compileId = function (i) {
    return (
        (i >= 0x0fff ? String.fromCharCode(97 + ((i & 0x0000f000) >> 0x0c)) : '') +
        (i >= 0x00ff ? String.fromCharCode(97 + ((i & 0x00000f00) >> 0x08)) : '') +
        (i >= 0x000f ? String.fromCharCode(97 + ((i & 0x000000f0) >> 0x04)) : '') +
        (i >= 0x0000 ? String.fromCharCode(97 + ((i & 0x0000000f) >> 0x00)) : '')
    );
};

const findId = function (_set, obj, _default, prefix) {
    if (!obj) return safeId('null');
    if (_default && _set[_default] === obj) return _default;
    if (_default && !_set[_default]) return _default;
    let index = Object.values(_set).indexOf(obj);
    if (index > -1) {
        return safeId(Object.keys(_set)[index]);
    } else if (!_default || _set[_default]) {
        _set.__nextId = (_set.__nextId || 0) + 1;
        return safeId(`${prefix || ''}${_set.__nextId}`);
    }
    return safeId(_default);
};

const memoify = function (fn) {
    const memo = {};
    return function (value) {
        return memo[value] || (memo[value] = fn(value));
    };
};

const titleCase = memoify(str => `${str[0].toUpperCase()}${str.substring(1)}`)
const enterTitleCase = memoify(str => `enter${titleCase(str)}`);
const exitTitleCase = memoify(str => `exit${titleCase(str)}`);

const _NODE_DATA = {
    null: {
        extends: null,
        keys: []
    },
    literal: {
        extends: null,
        keys: []
    },
    boolean: {
        extends: 'literal',
        keys: []
    },
    number: {
        extends: 'literal',
        keys: []
    },
    string: {
        extends: 'literal',
        keys: []
    },
    array: {
        extends: null,
        keys: null
    },
    root: {
        extends: null,
        keys: ['root']
    },
    node: {
        extends: null,
        keys: []
    },
    id: {
        extends: 'node',
        keys: ['id']
    },
    chunk: {
        extends: 'node',
        keys: ['statements']
    },
    statement: {
        extends: 'node',
        keys: ['expr']
    },
    expressionStatement: {
        extends: 'statement',
        keys: ['expr']
    },
    ifStatement: {
        extends: 'statement',
        keys: ['test', 'expr', 'ifFalse']
    },
    checkStatus: {
        extends: 'statement',
        keys: []
    },
    store: {
        extends: 'statement',
        keys: ['expr']
    },
    storeArg: {
        extends: 'store',
        keys: ['name', 'key', 'expr']
    },
    storeVar: {
        extends: 'store',
        keys: ['name', 'expr']
    },
    operator: {
        extends: 'node',
        keys: []
    },
    fixedOperator: {
        extends: 'operator',
        keys: []
    },
    cast: {
        extends: 'fixedOperator',
        keys: ['expect', 'value']
    },
    cast2: {
        extends: 'fixedOperator',
        keys: ['expect', 'input1', 'input2']
    },
    castArgs: {
        extends: 'fixedOperator',
        keys: ['expect', 'args']
    },
    property: {
        extends: 'fixedOperator',
        keys: ['lhs', 'member']
    },
    ifElse: {
        extends: 'fixedOperator',
        keys: ['test', 'ifTrue', 'ifFalse']
    },
    binaryOperator: {
        extends: 'fixedOperator',
        keys: ['operator', 'input1', 'input2']
    },
    call: {
        extends: 'operator',
        keys: []
    },
    callArgs: {
        extends: 'call',
        keys: ['func', 'args']
    },
    callBlock: {
        extends: 'call',
        keys: ['func', 'context', 'args']
    },
    callFunction: {
        extends: 'call',
        keys: ['func', 'args']
    },
    factory: {
        extends: 'node',
        keys: ['debugName', 'bindings', 'dereferences', 'chunks']
    },
    token: {
        extends: 'node',
        keys: ['token']
    },
    whitespace: {
        extends: 'node',
        keys: []
    }
};

const NODE_DATA = Object.entries(_NODE_DATA).reduce((obj, [type, value], code) => {
    const isArray = type === 'array';
    obj[type] = {
        // Identifying information
        type,
        code,

        // Type information
        extends: value.extends,
        isArray,
        isValue: (
            type === 'null' ||
            type === 'boolean' || type === 'number' || type === 'string' ||
            type === 'array'
        ),

        // Member information
        keys: value.keys,
        length: isArray ? -1 : value.keys.length
    };
    return obj;
}, {});

const NODE_NAMES = Object.keys(NODE_DATA);
const NODE_CODE_DATA = Object.values(NODE_DATA);

const NODE_CODES = NODE_NAMES.reduce((object, name, index) => {
    object[name] = index;
    return object;
}, {});

const NODE_CODE_NULL = NODE_CODES.null;
const NODE_CODE_LITERAL = NODE_CODES.literal;
const NODE_CODE_BOOLEAN = NODE_CODES.boolean;
const NODE_CODE_NUMBER = NODE_CODES.number;
const NODE_CODE_STRING = NODE_CODES.string;
const NODE_CODE_ARRAY = NODE_CODES.array;
const NODE_CODE_NODE = NODE_CODES.node;
const NODE_CODE_ID = NODE_CODES.id;
const NODE_CODE_CHUNK = NODE_CODES.chunk;
const NODE_CODE_STATEMENT = NODE_CODES.statement;
const NODE_CODE_EXPRESSION_STATEMENT = NODE_CODES.expressionStatement;
const NODE_CODE_CHECK_STATUS = NODE_CODES.checkStatus;
const NODE_CODE_STORE = NODE_CODES.store;
const NODE_CODE_STORE_ARG = NODE_CODES.storeArg;
const NODE_CODE_STORE_VAR = NODE_CODES.storeVar;
const NODE_CODE_OPERATOR = NODE_CODES.operator;
const NODE_CODE_CAST = NODE_CODES.cast;
const NODE_CODE_CAST2 = NODE_CODES.cast2;
const NODE_CODE_PROPERTY = NODE_CODES.property;
const NODE_CODE_IF_ELSE = NODE_CODES.ifElse;
const NODE_CODE_BINARY_OPERATOR = NODE_CODES.binaryOperator;
const NODE_CODE_CALL = NODE_CODES.call;
const NODE_CODE_CALL_BLOCK = NODE_CODES.callBlock;
const NODE_CODE_CALL_FUNCTION = NODE_CODES.callFunction;
const NODE_CODE_FACTORY = NODE_CODES.factory;
const NODE_CODE_TOKEN = NODE_CODES.token;
const NODE_CODE_WHITESPACE = NODE_CODES.whitespace;

const NODE_KEYS = Object.entries(NODE_DATA).reduce((object, [name, data]) => {
    object[name] = data.keys;
    return object;
}, {});

const NODE_CODE_KEYS = Object.values(NODE_DATA).map(data => data.keys);

const NODE_ANCESTORS = Object.entries(NODE_DATA).reduce((object, [name, data]) => {
    object[name] = [name];
    let _extends = data.extends;
    while (_extends && NODE_DATA[_extends]) {
        object[name].push(_extends);
        _extends = NODE_DATA[_extends].extends;
    }
    return object;
}, {});
// null has no ancestors
NODE_ANCESTORS.null = [];

const NODE_CODE_ANCESTORS = Object.values(NODE_ANCESTORS);

const NODE_IS_ANCESTOR = Object.entries(NODE_ANCESTORS).reduce((object, [name, keys]) => {
    object[name] = {};
    for (let i = 0; i < NODE_NAMES.length; i++) {
        object[name][NODE_NAMES[i]] = keys.indexOf(NODE_NAMES[i]) > -1;
    }
    return object;
}, {});

const NODE_CODE_IS_ANCESTOR = Object.values(NODE_IS_ANCESTOR);

const NODE_ENTER_KEYS = Object.entries(NODE_ANCESTORS).reduce((object, [name, keys]) => {
    object[name] = keys.concat(keys.map(enterTitleCase));
    return object;
}, {});
const NODE_EXIT_KEYS = Object.entries(NODE_ANCESTORS).reduce((object, [name, keys]) => {
    object[name] = keys.map(exitTitleCase);
    return object;
}, {});

const NODE_CODE_ENTER_KEYS = Object.values(NODE_ENTER_KEYS);
const NODE_CODE_EXIT_KEYS = Object.values(NODE_EXIT_KEYS);

const EMPTY_KEYS = [];

const ast = {
    clone (node) {
        if (Array.isArray(node)) {
            return node.slice();
        } else if (typeof node === 'object' && node) {
            const newNode = {};
            for (const key in node) {
                if (Array.isArray(node[key])) newNode[key] = node[key].slice();
                else newNode[key] = node[key];
            }
            return newNode;
        }
        return node;
    },
    cloneDeep (node) {
        if (Array.isArray(node)) {
            return node.map(ast.cloneDeep);
        } else if (typeof node === 'object' && node) {
            const newNode = {};
            for (const key in node) newNode[key] = key === 'typeData' ? node[key] : ast.cloneDeep(node[key]);
            return newNode;
        }
        return node;
    },
    nodeify (node) {
        // node
        if (node != null && node.typeCode > 0) {
            const data = NODE_CODE_DATA[node.typeCode];
            if (data.isArray) {
                for (let i = 0; i < node.value.length; i++) {
                    node.value[i] = ast.nodeify(node.value[i]);
                }
            } else if (!data.isValue) {
                const keys = data.keys;
                for (let j = 0; j < keys.length; j++) {
                    node[keys[j]] = ast.nodeify(node[keys[j]]);
                }
            }
            return node;
        }
        // array
        else if (Array.isArray(node)) {
            for (let k = 0; k < node.length; k++) {
                node[k] = ast.nodeify(node[k]);
            }
            return ast.array(node);
        }
        // string
        else if (typeof node === 'string') return ast.string(node);
        // number
        else if (typeof node === 'number') return ast.number(node);
        // boolean
        else if (typeof node === 'boolean') return ast.boolean(node);
        // everything else
        else return ast.null();
    },

    null () {
        return {
            type: 'null',
            typeCode: NODE_CODES.null,
            typeData: NODE_DATA.null,
            value: null
        };
    },
    boolean (value) {
        return {
            type: 'boolean',
            typeCode: NODE_CODES.boolean,
            typeData: NODE_DATA.boolean,
            value
        };
    },
    number (value) {
        return {
            type: 'number',
            typeCode: NODE_CODES.number,
            typeData: NODE_DATA.number,
            value
        };
    },
    string: Object.assign(function (value) {
        return {
            type: 'string',
            typeCode: NODE_CODES.string,
            typeData: NODE_DATA.string,
            value
        };
    }, {
        quote (str) {
            return `'${str}'`;
        },
        quoteLiteral (str) {
            return ast.string(ast.string.quote(str));
        },
        dequote (_str) {
            const str = _str.value || _str;
            if (/^'.*'$/.test(str)) {
                return str.substring(1, str.length - 1);
            } else {
                return str;
            }
        }
    }),
    array (value) {
        return {
            type: 'array',
            typeCode: NODE_CODES.array,
            typeData: NODE_DATA.array,
            value
        };
    },
    root (root) {
        return {
            type: 'root',
            typeCode: NODE_CODES.root,
            typeData: NODE_DATA.root,
            root
        };
    },
    id (id) {
        return {
            type: 'id',
            typeCode: NODE_CODES.id,
            typeData: NODE_DATA.id,
            id
        };
    },
    chunk (statements = []) {
        return {
            type: 'chunk',
            typeCode: NODE_CODES.chunk,
            typeData: NODE_DATA.chunk,
            statements
        };
    },
    expressionStatement (expr) {
        return {
            type: 'expressionStatement',
            typeCode: NODE_CODES.expressionStatement,
            typeData: NODE_DATA.expressionStatement,
            expr
        };
    },
    ifStatement (test, expr, ifFalse = []) {
        return {
            type: 'ifStatement',
            typeCode: NODE_CODES.ifStatement,
            typeData: NODE_DATA.ifStatement,
            test,
            expr,
            ifFalse
        };
    },
    checkStatus () {
        return {
            type: 'checkStatus',
            typeCode: NODE_CODES.checkStatus,
            typeData: NODE_DATA.checkStatus,
            expr: null
        };
    },
    storeArg (name, key, expr) {
        return {
            type: 'storeArg',
            typeCode: NODE_CODES.storeArg,
            typeData: NODE_DATA.storeArg,
            name,
            key,
            expr
        };
    },
    storeVar (name, expr) {
        return {
            type: 'storeVar',
            typeCode: NODE_CODES.storeVar,
            typeData: NODE_DATA.storeVar,
            name,
            expr
        };
    },
    // ifElseStatement () {},
    binding (name) {
        return ast.storeVar(name, ast.property('bindings', name));
    },
    cast (expect, value) {
        return {
            type: 'cast',
            typeCode: NODE_CODES.cast,
            typeData: NODE_DATA.cast,
            expect,
            value
        };
    },
    cast2 (expect, input1, input2) {
        return {
            type: 'cast2',
            typeCode: NODE_CODES.cast2,
            typeData: NODE_DATA.cast2,
            expect,
            input1,
            input2
        };
    },
    castArgs (expect, args) {
        return {
            type: 'castArgs',
            typeCode: NODE_CODES.castArgs,
            typeData: NODE_DATA.castArgs,
            expect,
            args
        };
    },
    castNumber (value) {
        return ast.cast('toNumber', value);
    },
    math (fn, value) {
        return ast.cast(ast.property('Math', fn), value);
    },
    math2 (fn, a, b) {
        return ast.cast2(ast.property('Math', fn), a, b);
    },
    property (lhs, member) {
        return {
            type: 'property',
            typeCode: NODE_CODES.property,
            typeData: NODE_DATA.property,
            lhs,
            member
        };
    },
    p (lhs, member) {
        return ast.property(lhs, member);
    },
    ifElse (test, ifTrue, ifFalse) {
        return {
            type: 'ifElse',
            typeCode: NODE_CODES.ifElse,
            typeData: NODE_DATA.ifElse,
            test,
            ifTrue,
            ifFalse
        };
    },
    binaryOperator (operator, input1, input2) {
        return {
            type: 'binaryOperator',
            typeCode: NODE_CODES.binaryOperator,
            typeData: NODE_DATA.binaryOperator,
            operator,
            input1,
            input2
        };
    },
    op2 (operator, input1, input2) {
        return ast.binaryOperator(operator, input1, input2);
    },
    callArgs (func, args) {
        return {
            type: 'callArgs',
            typeCode: NODE_CODES.callArgs,
            typeData: NODE_DATA.callArgs,
            func,
            args
        };
    },
    callBlock (context, func, args) {
        return {
            type: 'callBlock',
            typeCode: NODE_CODES.callBlock,
            typeData: NODE_DATA.callBlock,
            context,
            func,
            args
        };
    },
    callFunction (func, args) {
        return {
            type: 'callFunction',
            typeCode: NODE_CODES.callFunction,
            typeData: NODE_DATA.callFunction,
            func,
            args
        };
    },
    factory (debugName) {
        return {
            type: 'factory',
            typeCode: NODE_CODES.factory,
            typeData: NODE_DATA.factory,
            debugName,
            bindings: [],
            dereferences: [],
            chunks: []
        };
    },

    type: {
        isLiteral (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].literal;
        },
        isNull (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].null;
        },
        isBoolean (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].boolean;
        },
        isNumber (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].number;
        },
        isString (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].string;
        },
        isArray (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].array;
        },
        isId (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].id;
        },
        isChunk (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].chunk;
        },
        isStatement (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].statement;
        },
        isExpressionStatement (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].expressionStatement;
        },
        isIfStatement (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].ifStatement;
        },
        isCheckStatus (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].checkStatus;
        },
        isStore (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].store;
        },
        isStoreArg (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].storeArg;
        },
        isStoreVar (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].storeVar;
        },
        isOperator (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].operator;
        },
        isFixedOperator (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].fixedOperator;
        },
        isCast (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].cast;
        },
        isCast2 (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].cast2;
        },
        isCastArgs (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].castArgs;
        },
        isProperty (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].property;
        },
        ifElse (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].ifElse;
        },
        isBinaryOperator (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].binaryOperator;
        },
        isCall (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].call;
        },
        isCallArgs (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].callArgs;
        },
        isCallBlock (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].callBlock;
        },
        isCallFunction (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].callFunction;
        },
        isFactory (node) {
            return NODE_CODE_IS_ANCESTOR[nodeCode(node)].factory;
        },

        matchValue (value, node) {
            if (value == null && node == null) {
                return true;
            } else if (value == null || node == null) {
                return false;
            } else if (typeof value === 'string' && (
                typeof node === 'string' && node === value ||
                ast.type.isString(node) && node.value === value
            )) {
                return true;
            } else if (typeof value === 'number' && (
                typeof node === 'number' && node === value ||
                ast.type.isNumber(node) && node.value === value
            )) {
                return true;
            } else if (typeof value === 'boolean' && (
                typeof node === 'boolean' && node === value ||
                ast.type.isBoolean(node) && node.value === value
            )) {
                return true;
            } else if (value instanceof RegExp && (
                typeof node === 'string' && value.test(node) ||
                typeof node.value === 'string' && value.test(node.value)
            )) {
                return true;
            } else if (typeof value === 'function' && (
                // 'value' in node && !value(node.value) ||
                // typeof node !== 'object' && !value(node)
                value(node)
            )) {
                return true;
            }
            return false;
        },
        matchShape (shape, node) {
            if (!node || typeof node !== 'object') {
                return false;
            }
            for (const key in shape) {
                if ((typeof shape[key] === 'object' && !(shape[key] instanceof RegExp)) &&
                    !ast.type.matchShape(shape[key], node[key])
                ) {
                    return false;
                } else if ((typeof shape[key] !== 'object' || (shape[key] instanceof RegExp)) &&
                    !ast.type.matchValue(shape[key], node[key])
                ) {
                    return false;
                }
            }
            return true;
        }
    }
};

const code = {
    t (token) {
        return code.token(token);
    },
    token (token) {
        return {
            type: 'token',
            typeCode: NODE_CODES.token,
            typeData: NODE_DATA.token,
            token
        };
    },
    ws () {
        return code.whitespace();
    },
    whitespace () {
        return {
            type: 'whitespace',
            typeCode: NODE_CODES.whitespace,
            typeData: NODE_DATA.whitespace
        };
    }
};

const nodeType = function (node) {
    // node
    if (node != null && node.typeCode > -1) return node.type;
    // string
    else if (typeof node === 'string') return 'string';
    // array
    else if (Array.isArray(node)) return 'array';
    // boolean, number
    else if (node != null) return typeof node;
    // everything else
    else return 'null';
};

const nodeCode = function (node) {
    // node
    if (node != null && node.typeCode > -1) return node.typeCode;
    // string
    else if (typeof node === 'string') return NODE_CODE_STRING;
    // array
    else if (Array.isArray(node)) return NODE_CODE_ARRAY;
    // boolean, number
    else if (node != null) return NODE_CODES[typeof node];
    // everything else
    else return NODE_CODE_NULL;
};

const AVAILABLE = 0;
const ACTIVE = 2;
const REVIEW = 3;

const AT_HEAD = 0;
const IN_RANGE = 1;
const AT_TAIL = 2;
const OUT_OF_RANGE = 3;

class PathTree {
    constructor (depth = 0) {
        this.depth = depth;

        this.parent = null;

        this.node = null;

        this.data = null;
        this.value = null;
        this.keys = EMPTY_KEYS;
        this.length = -2;
        this.isArray = false;

        // state walking through members
        this.children = [];
        this._activeIndex = Infinity;
        this._index = Infinity;
        this.lastChild = 0;
    }
    set (parent, node) {
        this.parent = parent;

        this.node = node;
        this.data = node.typeData;
        if (this.isArray = this.data.isArray) {
            this.keys = EMPTY_KEYS;
            this.value = node.value;
            this.length = this.value.length;
        } else if (this.data.isValue) {
            this.keys = EMPTY_KEYS;
            this.value = node.value;
            this.length = this.data.length;
        } else {
            this.keys = this.data.keys;
            this.value = node;
            this.length = this.data.length;
        }

        for (let i = this.children.length, l = this.length; i < l; i++) {
            window.NEW_NODES = (window.NEW_NODES | 0) + 1;
            this.children[i] = new PathTree(this.depth + 1);
        }

        // this.typeCode = node.data.typeCode;
        // this.isArray = node.data.isArray;
        // this.keys = node.data.keys || node;
        // this.length = this.keys.length;
        // this.value = node.data.isLiteral ? node.value : node;

        this._index = -1;
    }
    reset () {
        this.node = null;
        this._activeIndex = Infinity;
        this._index = Infinity;
        this.length = -2;
        for (let i = 0; i < this.lastChild; i++) {
            if (!isAvailable(this.children[i])) this.children[i].reset();
        }
        this.lastChild = 0;
    }
    next () {
        if (isReview(this)) {
            let i = this._activeIndex + 1;
            let l = Math.min(this._index, this.lastChild);
            for (; i < l && !this.children[i].isActive; i++) {}
            if (i === l) {
                this._activeIndex = Infinity;
            } else {
                this._activeIndex = i;
            }
            return;
        }
        if (this._index <= this.length) {
            this._index = Math.min(this._index + 1, this.lastChild + 1);
        }
    }
    _attach (index) {
        // if (index >= this.length) throw new Error('Can only attach children that exist');
        let child = this.children[index];
        if (isAvailable(child)) {
            child.set(this, this.value[this.isArray ? index : this.keys[index]]);
            if (index < this._index - 1) child._index = child.length + 1;
            this.lastChild = Math.max(this.lastChild, index + 1);
        }
        return child;
    }
    attachQuiet (index) {
        return this._attach(index);
    }
    attach (index) {
        const child = this._attach(index);
        child._index = -1;
        return child;
    }
    detach (index) {
        if (index >= 0) this.children[index].reset();
        return this;
    }
    push () {
        return this._attach(this.index);
    }
    pop () {
        return this.parent.detach(this.keyIndex);
    }
    peekNode () {
        return this.value[this.isArray ? this.index : this.keys[this.index]];
    }

    get isAvailable () {
        return this.length < 0;
    }
    get isActive () {
        return this.length >= 0;
    }
    get isReview () {
        return this._activeIndex < this.length;
    }
    get atHead () {
        return this._index === -1;
    }
    get inRange () {
        return this._index < this.length || this._activeIndex < this.length;
    }
    get atTail () {
        return this._index === this.length && this._activeIndex >= this.length;
    }
    get atTailOfLeaf () {
        return this.length === 0;
    }
    get outOfRange () {
        return this._index > this.length && this._activeIndex >= this.length;
    }
    get visitStage () {
        const {_activeIndex, _index, length} = this;
        if (_index === -1) return AT_HEAD;
        else if (_index < length || _activeIndex < length) return IN_RANGE;
        else if (_index === length) return AT_TAIL;
        else return OUT_OF_RANGE;
    }

    get index () {
        return Math.min(this._activeIndex, this._index);
    }
    get type () {
        return this.data.type;
    }
    get typeCode () {
        return this.data.code;
    }
    get keyIndex () {
        return this.parent.children.indexOf(this);
    }
    get key () {
        return this.parent.isArray ? this.keyIndex : this.parent.keys[this.keyIndex];
    }
    get parentKey () {
        return this.parent.key;
    }
    get parentNode () {
        return this.parent.node;
    }
    get root () {
        let parent = this;
        while (parent && parent.depth > 0) parent = parent.parent;
        return parent;
    }
    get rootNode () {
        return this.root.node;
    }

    skip () {
        this.reset();
    }
    stop () {
        this.root.reset();
    }

    assertActive () {
        let path = this;
        while (path.parent && (path.isActive || path.keyIndex > -1)) path = path.parent;
        if (path.depth > -1) throw new Error('Path must be active to modify the tree');
    }
    assertArray () {
        this.assertActive();
        if (!this.isArray) throw new Error('Path must be an array');
    }

    changeTree (index) {
        let path = this;
        if (index + 1 < path.index) path._activeIndex = index;
        while (path.parent && (path.keyIndex + 1 < path.parent.index)) {
            path.parent._activeIndex = path.keyIndex;
            path = path.parent;
        }
    }

    setKey (key, node) {
        this.assertActive();

        this.value[key] = ast.nodeify(node);
        const index = this.isArray ? key : this.keys.indexOf(key);

        this.changeTree(index);
        this.detach(index);
        return this.attach(index);
    }
    getKey (key) {
        this.assertActive();
        return this.attachQuiet(this.isArray ? key : this.keys.indexOf(key));
    }

    refresh () {
        this.assertActive();
        while (!this.isActive) {
            let path = this;
            while (!path.parent.isActive) path = path.parent;
            const index = path.keyIndex;
            // if (index >= path.parent.lastChild) throw new Error('Path appears to not be apart of the graph');
            path.parent.attachQuiet(path.keyIndex);
        }
        return this;
    }

    remove () {
        this.assertActive();
        const index = this.keyIndex;
        if (index === -1) throw new Error('Cannot remove path that is not in parent');
        this.parent.detach(index);
        if (this.parent.isArray) {
            if (index <= this.parent._index) {
                this.parent._index--;
            }
            if (index <= this.parent._activeIndex) {
                this.parent._activeIndex--;
            }
            if (index <= this.parent.lastChild) {
                this.parent.lastChild--;
            }
            this.parent.length--;
            this.parent.value.splice(index, 1);
            this.parent.children.splice(index, 1);
        } else {
            if (index === this.parent._index - 1) this.parent._index -= 1;
            if (index === this.parent._activeIndex - 1) this.parent._activeIndex -= 1;
            this.parent.value[this.key] = null;
        }
    }

    replaceWith (node) {
        this.assertActive();

        const index = this.keyIndex;
        if (index === -1) throw new Error('Cannot replace path that is not in parent');
        this.parent.value[this.key] = ast.nodeify(node);

        this.changeTree(index);
        this.parent.detach(index);
        return this.parent.attach(index);
    }

    insertChild (index, node) {
        this.assertArray();

        if (index <= this._index) this._index++;
        if (index <= this._activeIndex) this._activeIndex++;
        if (index <= this.lastChild) this.lastChild++;

        this.length++;
        this.value.splice(index, 0, ast.nodeify(node));
        this.children.splice(index, 0, new PathTree(this.depth + 1));
        this.changeTree(index);
        return this.attach(index);
    }
    prependChild (node) {
        return this.insertChild(0, node);
    }
    appendChild (node) {
        return this.insertChild(this.length, node);
    }

    insertFirst (node) {
        return this.parent.prependChild(node);
    }
    insertLast (node) {
        return this.parent.appendChild(node);
    }
    insertBefore (node) {
        return this.parent.insertChild(this.key, node);
    }
    insertAfter (node) {
        return this.parent.insertChild(this.key + 1, node);
    }
}

const isAvailable = function (path) {
    return path.length < 0;
}
const isActive = function (path) {
    return path.length >= 0;
}
const isReview = function (path) {
    return path._activeIndex < path.length;
}

const index = function (path) {
    return Math.min(path._activeIndex, path._index);
}
const atHead = function (path) {
    return path._index === -1;
}
const inRange = function (path) {
    return path._index < path.length || path._activeIndex < path.length;
}
const atTail = function (path) {
    return path._index === path.length && path._activeIndex >= path.length;
}
const atTailOfLeaf = function (path) {
    return path.length === 0;
}
const outOfRange = function (path) {
    return path._index > path.length && path._activeIndex >= path.length;
}
const visitStage = function (path) {
    const {_activeIndex, _index, length} = path;
    if (_index === -1) return AT_HEAD;
    else if (_index < length || _activeIndex < length) return IN_RANGE;
    else if (_index === length) return AT_TAIL;
    else return OUT_OF_RANGE;
}

const getPrototypeAncestry = function (proto) {
    const ancestry = [];
    while (proto && proto !== Object.prototype) {
        ancestry.push(proto);
        proto = Object.getPrototypeOf(proto);
    }
    return ancestry;
};
const getAllPropertyNames = function (proto) {
    const keySet = new Set();
    const protos = getPrototypeAncestry(proto);
    for (let i = 0; i < protos.length; i++) {
        const keys = Object.getOwnPropertyNames(protos[i]);
        for (let j = 0; j < keys.length; j++) keySet.add(keys[j]);
    }
    return Array.from(keySet);
};
const visit = function (path, visitFunctions) {
    const {value, node} = path;
    for (let j = 0; j < visitFunctions.length && path.isActive && node === path.node; j += 2) {
        visitFunctions[j](value, path, visitFunctions[j + 1]);
    }
    return node === path.node;
};
class Transformer {
    constructor (visitors) {
        this.path = new PathTree(-1);

        this.visitors = null;
        this.visitKeys = null;
        this.visitTypes = null;

        this.initVisitors(visitors);
    }
    transform (root, states) {
        const {enter, willEnter, exit, willExit, willVisit} = this.setStates(states);

        this.path.set(null, ast.root(root));
        this.path.next();
        let path = this.path.push();
        path.parent.next();

        let dog = 100000;
        let node;
        let run = true;
        while (run) {
            switch (visitStage(path)) {
            case IN_RANGE:
                path = path.push();
                if (path.depth > 100) throw new Error('Path is too deep');
                path.parent.next();
                if (!atHead(path)) break;
            case AT_HEAD:
                if (!willEnter[path.typeCode] || visit(path, enter[path.typeCode])) path.next();
                if (!atTail(path)) break;
            case AT_TAIL:
                if (willExit[path.typeCode] && !visit(path, exit[path.typeCode])) break;
            case OUT_OF_RANGE:
                do {
                    path = path.pop();
                } while (path.depth > -1 && (outOfRange(path) || (atTail(path) && !willExit[path.typeCode])));
                if (path.depth === -1 && (outOfRange(path) || atTail(path))) run = false;
            }
        }

        path.reset();
    }
    initVisitors (visitors) {
        this.visitors = visitors || [];
        const visitKeys = this.visitKeys = Object.create(null);
        for (let i = 0; i < visitors.length; i++) {
            const visitor = visitors[i];
            const keys = getAllPropertyNames(visitor);
            for (let j = 0; j < keys.length; j++) {
                const key = keys[j];
                if (typeof visitor[keys[j]] === 'function') {
                    visitKeys[key] = (visitKeys[key] || []);
                    visitKeys[key].push(visitor[key], i);
                }
            }
        }
        const visitTypes = this.visitTypes = [];
        for (let k = 0; k < NODE_NAMES.length; k++) {
            const enterKeys = NODE_CODE_ENTER_KEYS[k];
            const exitKeys = NODE_CODE_EXIT_KEYS[k];

            const typeFunctions = visitTypes[k] = {enter: [], exit: [], keys: NODE_CODE_DATA[k].keys};

            for (const [mode, keys] of [[typeFunctions.enter, enterKeys], [typeFunctions.exit, exitKeys]]) {
                for (let l = 0; l < keys.length; l++) {
                    for (let n = 0; n < visitors.length; n++) {
                        if (visitors[n][keys[l]]) mode.push(visitors[n][keys[l]], n);
                    }
                }
            }
        }
    }
    setStates (states) {
        const visitTypes = this.visitTypes;
        const visitTypesBound = {enter: [], willEnter: [], exit: [], willExit: [], willVisit: []};
        for (let k = 0; k < NODE_NAMES.length; k++) {
            const typeFunctions = visitTypes[k];;

            const typeFunctionsBoundEnter = visitTypesBound.enter[k] = [];
            for (let l = 0; l < typeFunctions.enter.length; l += 2) {
                typeFunctionsBoundEnter.push(typeFunctions.enter[l], states[typeFunctions.enter[l + 1]]);
            }
            visitTypesBound.willEnter[k] = typeFunctionsBoundEnter.length > 0;

            const typeFunctionsBoundExit = visitTypesBound.exit[k] = [];
            for (let m = 0; m < typeFunctions.exit.length; m += 2) {
                typeFunctionsBoundExit.push(typeFunctions.exit[m], states[typeFunctions.exit[m + 1]]);
            }
            visitTypesBound.willExit[k] = typeFunctionsBoundExit.length > 0;

            visitTypesBound.willVisit[k] = (
                k === NODE_CODE_ARRAY ||
                typeFunctions.keys.length > 0 ||
                visitTypesBound.willEnter[k] ||
                visitTypesBound.willExit[k]
            );
        }
        return visitTypesBound;
    }
}
class JSCountRefs {
    string (node, path, state) {
        if (path.key === 'key' || path.key === 'member') return;
        if (path.key === 'name' && path.parentNode.type === 'storeVar') return;
        state.strings.push(node);
        const refNode = state.vars[node];
        if (refNode) refNode.uses++;
    }
    storeVar (node, path, state) {
        if (!state.vars[node.name.value]) {
            node.uses = 0;
            node.scope = path.parent.key;
            if (typeof node.scope !== 'string') {
                node.scope = path.parent.parent.key;
            }
            state.vars[node.name.value] = node;
            state.varPaths[node.name.value] = path;

            state.reassign[node.name.value] = node;
        } else {
            node.uses = -1;
        }
    }
    checkStatus (node, path, state) {
        const refNode = state.vars.thread;
        if (refNode) refNode.uses++;
    }
    expressionStatement (node, path, state) {
        if (ast.type.matchShape({expr: {operator: '=', input1: ast.type.isString}}, node)) {
            if (state.reassign[node.expr.input1.value]) {
                node.used = false;
            } else {
                state.reassign[node.expr.input1.value] = node;
            }
        }
    }
    call (node, path, state) {
        if (ast.type.matchShape({func: /^vm_(may_continue|do_stack)$|^handlePromise$/}, node)) {
            state.reassign = {};
        }
    }
    cast (node, path, state) {
        if (ast.type.matchShape({expect: {lhs: 'thread', member: 'reuseStackForNextBlock'}}, node)) {
            state.reassign = {};
        }
    }
}
class JSFindArg {
    exitStoreArg (node, path, state) {
        state.paths[node.name.value] = state.paths[node.name.value] || {};
        state.paths[node.name.value][node.key.value] = path;
    }
}
const findArg = new JSFindArg();
const createHelper = function (state, path, name, body) {
    state.paths[name] = path.root.getKey('bindings').appendChild(ast.storeVar(name, body));
};

class InlineBlocks {
    constructor () {
        Object.defineProperty(this, 'helpers', {value: this.helpers});
        Object.defineProperty(this, 'opcodes', {value: Object.entries(this.opcodes).reduce((ops, [key, handle]) => {
            ops[key] = handle.bind(this);
            return ops;
        }, {})});
        Object.defineProperty(this, 'reducers', {value: Object.entries(this.reducers).reduce((ops, [key, handle]) => {
            ops[key] = handle.bind(this);
            return ops;
        }, {})});

        this.call = this.call.bind(this);
        this.exitCast = this.exitCast.bind(this);
        this.exitCast2 = this.exitCast2.bind(this);
        this.exitCastArgs = this.exitCastArgs.bind(this);
    }

    get helpers () {
        return {};
    }
    get opcodes () {
        return {};
    }
    get reducers () {
        return {};
    }

    call (node, path, state) {
        const info = state.opMap[node.args.value];
        if (info && this.opcodes[info.op.opcode]) {
            this.opcodes[info.op.opcode](node, path, state, info);
        }
    }
    exitCast (node, path, state) {
        const pathNode = path.node;

        if (this.reducers[node.expect.value]) this.reducers[node.expect.value](node, path, state);
        if (pathNode !== path.node) return;

        if (!state.paths[node.expect.value] && this.helpers[node.expect.value]) {
            createHelper(state, path, node.expect.value,
                ast.cloneDeep(this.helpers[node.expect.value]));
        }
    }
    exitCast2 (node, path, state) {
        const pathNode = path.node;

        if (this.reducers[node.expect.value]) this.reducers[node.expect.value](node, path, state);
        if (pathNode !== path.node) return;

        if (!state.paths[node.expect.value] && this.helpers[node.expect.value]) {
            createHelper(state, path, node.expect.value,
                ast.cloneDeep(this.helpers[node.expect.value]));
        }
    }
    exitCastArgs (node, path, state) {
        const pathNode = path.node;

        if (this.reducers[node.expect.value]) this.reducers[node.expect.value](node, path, state);
        if (pathNode !== path.node) return;

        if (!state.paths[node.expect.value] && this.helpers[node.expect.value]) {
            createHelper(state, path, node.expect.value,
                ast.cloneDeep(this.helpers[node.expect.value]));
        }
    }
}
class InlineDataBlocks extends InlineBlocks {
    get helpers () {
        return {
            listGetIndex: [
                'function ($l, $_i) {',
                    'var $i = ', 'toListIndex', '($_i, $l.value.length);',
                    'return $i === ', 'LIST_INVALID', ` ? '' : $l.value[$i - 1];`,
                '}'
            ],
            listSetIndex: [
                'function ($l, $_i, $item) {',
                    'var $i = ', 'toListIndex', '($_i, $l.value.length);',
                    'if ($i === ', 'LIST_INVALID', ') return;',
                    '$l.value[$i - 1] = $item;',
                    '$l._monitorUpToDate = false;',
                '}'
            ],
            listAdd: [
                'function ($l, $item) {',
                    'if ($l.value.length < ', 200000, ') {',
                        '$l.value.push($item);',
                        '$l._monitorUpToDate = false;',
                    '}',
                '}'
            ],
            listDelete: [
                'function ($l, $_i) {',
                    'var $i = ', 'toListIndex', '($_i, $l.value.length);',
                    'if ($i === ', 'LIST_INVALID', ') return;',
                    'if ($i === ', 'LIST_ALL', ') {',
                        '$l.value = [];',
                    '} else {',
                        '$l.value.splice($i - 1, 1);',
                    '}',
                    '$l._monitorUpToDate = false;',
                '}'
            ],
            listIndexOf: [
                'function ($l, $item) {',
                    'for (let $i = 0; $i < $l.value.length; $i++) {',
                        'if (Cast.compare($l.value[$i], $item) === 0) {',
                            'return $i + 1;',
                        '}',
                    '}',
                    'return 0;',
                '}'
            ]
        };
    }
    get opcodes () {
        return {
            data_variable: this.data_variable,
            data_setvariableto: this.data_setvariableto,
            data_changevariableby: this.data_changevariableby,

            data_addtolist: this.data_addtolist,
            data_deleteoflist: this.data_deleteoflist,
            data_deletealloflist: this.data_deletealloflist,
            data_replaceitemoflist: this.data_replaceitemoflist,
            data_itemoflist: this.data_itemoflist,
            data_itemnumoflist: this.data_itemnumoflist,
            data_lengthoflist: this.data_lengthoflist,
            data_listcontainsitem: this.data_listcontainsitem

            // TODO
            // data_insertatlist: this.data_insertatlist,
        };
    }

    insertLookup (node, path, state, info) {
        const {id, name} = info.op._argValues.VARIABLE;
        const dataId = `data_${safeId(name)}`;

        let lookup = ast.p('target', `lookupOrCreateVariable('${id}', '${name}')`);

        const thread = blockUtility.thread;
        const original = thread.target.sprite.clones[0];
        // If we have a local copy, return it.
        if (original.variables.hasOwnProperty(id)) {
            lookup = ast.p(ast.p('target', 'variables'), ast.string.quote(id));
        }
        // If the stage has a global copy, return it.
        else if (original.runtime && !original.isStage) {
            const stage = original.runtime.getTargetForStage();
            if (stage && stage.variables.hasOwnProperty(id)) {
                path.root.getKey('dereferences').appendChild(
                    ast.storeVar('stage',
                        ast.p(ast.p('target', 'runtime'), 'getTargetForStage()')));
                lookup = ast.p(ast.p('stage', 'variables'), ast.string.quote(id));
            }
        }

        path.parent.insertBefore(ast.storeVar(dataId, ast.cloneDeep(lookup)));
        path.parent.insertBefore(ast.expressionStatement(ast.op2('=',
            dataId,
            ast.op2('||', dataId, ast.cloneDeep(lookup)))));

        return dataId;
    }

    updateCloud (node, path, state, info) {
        const {id, name} = info.op._argValues.VARIABLE;
        const valudId = `${node.args.value}_value`;
        const target = blockUtility.thread.target;
        const variable = target.lookupOrCreateVariable(id, name);
        if (variable.isCloud) {
            path.parent.insertAfter(
                ast.callArgs(ast.p('blockUtility', 'ioQuery'), [
                    `'cloud'`,
                    `'requestUpdateVariable'`,
                    [`'${name}'`, valudId]
                ]));
        }
    }

    insertListLookup (node, path, state, info) {
        const {id, name} = info.op._argValues.LIST;
        const dataId = `data_list_${safeId(name)}`;

        let lookup = ast.p('target', `lookupOrCreateList('${id}', '${name}')`);

        const thread = blockUtility.thread;
        const original = thread.target.sprite.clones[0];
        // If we have a local copy, return it.
        if (original.variables.hasOwnProperty(id)) {
            lookup = ast.p(ast.p('target', 'variables'), ast.string.quote(id));
        }
        // If the stage has a global copy, return it.
        else if (original.runtime && !original.isStage) {
            const stage = original.runtime.getTargetForStage();
            if (stage && stage.variables.hasOwnProperty(id)) {
                path.root.getKey('dereferences').appendChild(
                    ast.storeVar('stage',
                        ast.p(ast.p('target', 'runtime'), 'getTargetForStage()')));
                lookup = ast.p(ast.p('stage', 'variables'), ast.string.quote(id));
            }
        }

        path.parent.insertBefore(ast.storeVar(dataId, ast.cloneDeep(lookup)));
        path.parent.insertBefore(ast.expressionStatement(ast.op2('=',
            dataId, ast.op2('||', dataId, ast.cloneDeep(lookup)))));

        return dataId;
    }

    data_variable (node, path, state, info) {
        path.replaceWith(ast.p(this.insertLookup(node, path, state, info), 'value'));
    }

    data_setvariableto (node, path, state, info) {
        const dataId = this.insertLookup(node, path, state, info);

        const valudId = `${node.args.value}_value`;
        path.parent.insertBefore(ast.storeVar(valudId, ast.p(node.args, 'VALUE')));

        this.updateCloud(node, path, state, info);

        path.parent.replaceWith(ast.storeArg(dataId, 'value', valudId));
    }

    data_changevariableby (node, path, state, info) {
        const dataId = this.insertLookup(node, path, state, info);

        const valudId = `${node.args.value}_value`;
        path.parent.insertBefore(ast.storeVar(valudId,
            ast.op2('+',
                ast.castNumber(ast.p(dataId, 'value')),
                ast.castNumber(ast.p(node.args, 'VALUE')))));

        this.updateCloud(node, path, state, info);

        path.parent.replaceWith(ast.storeArg(dataId, 'value', valudId));
    }

    data_addtolist (node, path, state, info) {
        const dataId = this.insertListLookup(node, path, state, info);
        path.replaceWith(ast.castArgs('listAdd',
            [dataId, ast.p(node.args, 'ITEM')]));
    }

    data_deleteoflist (node, path, state, info) {
        const dataId = this.insertListLookup(node, path, state, info);
        path.replaceWith(ast.cast2('listDelete',
            dataId, ast.p(node.args, 'INDEX')));
    }

    data_deletealloflist (node, path, state, info) {
        const dataId = this.insertListLookup(node, path, state, info);
        path.parent.replaceWith(ast.storeArg(dataId, 'value', '[]'));
    }

    data_replaceitemoflist (node, path, state, info) {
        const dataId = this.insertListLookup(node, path, state, info);
        path.replaceWith(ast.castArgs('listSetIndex',
            [dataId, ast.p(node.args, 'INDEX'), ast.p(node.args, 'ITEM')]));
    }

    data_itemoflist (node, path, state, info) {
        const dataId = this.insertListLookup(node, path, state, info);
        path.replaceWith(ast.cast2('listGetIndex',
            dataId, ast.p(node.args, 'INDEX')));
    }

    data_itemnumoflist (node, path, state, info) {
        const dataId = this.insertListLookup(node, path, state, info);
        path.replaceWith(ast.castArgs('listIndexOf',
            [dataId, ast.p(node.args, 'ITEM')]));
    }

    data_lengthoflist (node, path, state, info) {
        const dataId = this.insertListLookup(node, path, state, info);
        path.replaceWith(ast.p(ast.p(dataId, 'value'), 'length'));
    }

    data_listcontainsitem (node, path, state, info) {
        const dataId = this.insertListLookup(node, path, state, info);
        path.replaceWith(ast.op2('>', ast.castArgs('listIndexOf',
            [dataId, ast.p(node.args, 'ITEM')]), 0));
    }
}
class InlineMathBlocks extends InlineBlocks {
    get opcodes () {
        return {
            operator_add: this.operator_add,
            operator_subtract: this.operator_subtract,
            operator_multiply: this.operator_multiply,
            operator_divide: this.operator_divide,
            operator_round: this.operator_round,
            operator_mod: this.operator_mod,
            operator_mathop: this.operator_mathop
        };
    }
    get helpers () {
        return {
            round10: 'function (value) {return (value + (value % 1e-10) - ((2 * value) % 1e-10));}',
            scratchTan: [
                'function ($v) {return (',
                '(Math.abs($v + 180) % 180 === 90)',
                'Math.sign(($v + 360) % 360 - 180) * Infinity',
                    ast.cast('round10', 'Math.sin((Math.PI * $v) / 180)'),
                ');}'
            ],
            scratchMod1: [
                'function (n, m) {return (n % 1) + (n % 1 < 0);}'
            ],
            scratchMod: [
                'function (n, m) {return (n % m) + ((n % m) * m < 0) * m;}'
            ]
        };
    }
    get reducers () {
        return {
            toNumber: this.toNumber,
            scratchMod: this.scratchMod
        };
    }

    operator_ (node, path, state, op) {
        path.replaceWith(ast.op2(op,
            ast.castNumber(ast.p(node.args, 'NUM1')),
            ast.castNumber(ast.p(node.args, 'NUM2'))));
    }
    operator_add (node, path, state) {
        this.operator_(node, path, state, '+');
    }
    operator_subtract (node, path, state) {
        this.operator_(node, path, state, '-');
    }
    operator_multiply (node, path, state) {
        this.operator_(node, path, state, '*');
    }
    operator_divide (node, path, state) {
        this.operator_(node, path, state, '/');
    }
    operator_round (node, path, state) {
        path.replaceWith(ast.math('round',
            ast.castNumber(ast.p(node.args, 'NUM'))));
    }
    operator_mod (node, path, state) {
        const NUM1 = ast.castNumber(ast.p(node.args, 'NUM1'));
        const NUM2 = ast.castNumber(ast.p(node.args, 'NUM2'));

        path.replaceWith(ast.cast2('scratchMod', NUM1, NUM2));
    }
    operator_mathop (node, path, state) {
        const info = state.opMap[node.args.value];
        const operator = Cast.toString(info.op._argValues.OPERATOR).toLowerCase();
        const NUM = ast.castNumber(ast.p(node.args, 'NUM'));
        switch (operator) {
        case 'ceiling':
            operator = 'ceil';
        case 'abs':
        case 'floor':
        case 'sqrt':
            return path.replaceWith(ast.math(operator, NUM));
        case 'ln':
            return path.replaceWith(ast.math('log', NUM));
        case 'e ^':
            return path.replaceWith(ast.math('exp', NUM));
        case 'asin':
        case 'acos':
        case 'atan':
            // operator(NUM) * 180 / Math.PI
            return path.replaceWith(ast.op2('/', ast.op2('*', ast.math(operator, NUM), 180), ast.p('Math', 'PI')));
        case 'log':
            // log(NUM) / Math.LN10
            return path.replaceWith(ast.op2('/', ast.math('log', NUM), ast.p('Math', 'LN10')));
        case '10 ^':
            return path.replaceWith(ast.math2('pow', 10, NUM));
        case 'sin':
        case 'cos':
            // round10(operator(NUM * Math.PI / 180))
            return path.replaceWith(ast.cast('round10',
                ast.math(operator, ast.op2('/',
                    ast.op2('*', NUM, ast.p('Math', 'PI')),
                    180))));
        case 'tan':
            return path.replaceWith(ast.cast('scratchTan', NUM));
        default:
            return path.replaceWith(0);
        }
    }

    toNumber (node, path, state) {
        if (ast.type.matchShape({value: ast.type.isNumber}, node) ||
            ast.type.matchShape({value: {operator: /^([+*<>]|-|===|&&|\|\|)$/}}, node) ||
            ast.type.matchShape({value: {expect: {lhs: 'Math', member: /^(abs|floor|ceil|sin|cos|tan|pow)$/}}}, node) ||
            ast.type.matchShape({value: {expect: /^(round10|scratchMod|scratchTan)$/}}, node)) {
            return path.replaceWith(node.value);
        } else if (ast.type.matchShape({
            value: value => !isNaN(Number(ast.string.dequote(value)))
        }, node)) return path.replaceWith(Number(ast.string.dequote(node.value)));
    }

    scratchMod (node, path, state) {
        if (ast.type.isNumber(node.input2) && node.input2.value === 1) {
            path.replaceWith(ast.cast('scratchMod1', node.input1));
        }
    }
}
class InlineBooleanBlocks extends InlineBlocks {
    get opcodes () {
        return {
            operator_lt: this.operator_lt,
            operator_equals: this.operator_equals,
            operator_gt: this.operator_gt,
            operator_and: this.operator_and,
            operator_or: this.operator_or,
            operator_not: this.operator_not
        };
    }
    get reducers () {
        return {
            toBoolean: this.toBoolean
        };
    }

    compareOperator (operator, node, path, state, info) {
        path.replaceWith(ast.op2(operator,
            ast.cast2('compare',
                ast.p(node.args, 'OPERAND1'), ast.p(node.args, 'OPERAND2')),
            0));
    }
    truthyOperator (operator, node, path, state, info) {
        path.replaceWith(ast.op2(operator,
            ast.cast('toBoolean', ast.p(node.args, 'OPERAND1')),
            ast.cast('toBoolean', ast.p(node.args, 'OPERAND2'))));
    }
    operator_lt (node, path, state, info) {
        this.compareOperator('<', node, path, state, info);
    }
    operator_equals (node, path, state, info) {
        this.compareOperator('===', node, path, state, info);
    }
    operator_gt (node, path, state, info) {
        this.compareOperator('>', node, path, state, info);
    }
    operator_and (node, path, state, info) {
        this.truthyOperator('&&', node, path, state, info);
    }
    operator_or (node, path, state, info) {
        this.truthyOperator('||', node, path, state, info);
    }
    operator_not (node, path, state, info) {
        path.replaceWith(ast.cast('!', ast.cast('toBoolean', ast.p(node.args, 'OPERAND'))));
    }

    toBoolean (node, path, state) {
        if (ast.type.matchShape({value: ast.type.isBoolean}, node) ||
            ast.type.matchShape({value: {operator: /^([<>]|===|&&|\|\|)$/}}, node)) {
            return path.replaceWith(node.value);
        } else if (ast.type.matchShape({
            value: value => ast.string.dequote(value) === 'true' || ast.string.dequote(value) === 'false'
        }, node)) return path.replaceWith(ast.string.dequote(node.value) === 'true');
    }
}
class InlineArgumentBlocks extends InlineBlocks {
    get opcodes () {
        return {
            argument_reporter_string_number: this.argument_reporter_string_number,
            argument_reporter_boolean: this.argument_reporter_boolean
        };
    }
    get helpers () {
        return {
            definedOr: [
                'function (v, d) {return typeof v === \'undefined\' ? d : v;}'
            ],
            getParam: [
                'function (t, k) {return t.stackFrame.params[k];}'
            ]
        };
    }
    get reducers () {
        return {
            getParam: this.getParam
        };
    }

    argument_reporter_string_number (node, path, state, info) {
        path.replaceWith(
            ast.cast2('definedOr',
                ast.cast2('getParam',
                    'thread',
                    ast.p(node.args, 'VALUE')),
                0));
    }
    argument_reporter_boolean (node, path, state, info) {
        this.argument_reporter_string_number(node, path, state, info);
    }

    getParam (node, path, state) {
        if (ast.type.matchShape({input1: 'thread', input2: ast.type.isString}, node)) {
            path.replaceWith(ast.p(ast.p('thread', 'stackFrame.params'), node.input2));
        }
    }
}
class JSInlineOperators {
    call (node, path, state) {
        const info = state.opMap[node.args.value];
        // info && /control_/.test(info.op.opcode) && console.log(Object.keys(info.args), info.op.inputs, info.op.fields, blockUtility.thread.blockContainer.getBranch(info.op.id, 1));
        if (info && info.op.opcode === 'vm_may_continue') {
            let chunkPath = path.parent;
            while (chunkPath.type !== 'array') {
                chunkPath = chunkPath.parent;
            }
            const chunkParent = chunkPath.parentNode;
            const chunkIndex = chunkPath.key;

            // chunkPath.prependChild(ast.storeArg(ast.p('thread', 'stackFrame'), 'blockIndex'))

            const afterAnother = chunkParent.value.some((chunk, index) => (
                index < chunkIndex &&
                (chunk.value.some(statement => (
                    ast.type.matchShape({expr: {func: /^vm_(may_continue|do_stack)$/}}, statement) ||
                    ast.type.matchShape({expr: {expect: {lhs: 'thread', member: 'reuseStackForNextBlock'}}}, statement)
                )))
            ));
            // if (!afterAnother) return;
            const beforeAnother = chunkParent.value.some((chunk, index) => (
                index > chunkIndex &&
                (chunk.value.some(statement => (
                    ast.type.matchShape({expr: {func: /^vm_(may_continue|do_stack)$/}}, statement)
                )))
            ));
            if (!beforeAnother) return;

            const lastChunk = chunkParent.value[chunkIndex - 1];
            if (lastChunk) {
                let i = lastChunk.value.length - 1;
                for (; i >= 0; i--) {
                    const statement = lastChunk.value[i];
                    if (ast.type.isCheckStatus(statement)) continue;
                    if (
                        ast.type.isStatement(statement) &&
                        !(
                            ast.type.isLiteral(statement.expr) ||
                            ast.type.isProperty(statement.expr) ||
                            ast.type.isBinaryOperator(statement.expr) ||
                            ast.type.isCast(statement.expr) ||
                            ast.type.isCast2(statement.expr) ||
                            ast.type.isCastArgs(statement.expr)
                        )
                    ) return;
                }
            }

            for (let i = chunkIndex - 1; i >= 0; i--) {
                const chunk = chunkParent.value[i];
                let k = -1;
                for (let j = chunk.value.length - 1; j >= 0; j--) {
                    const statement = chunk.value[j];
                    if (
                        ast.type.isIfStatement(statement) ||
                        ast.type.matchShape({expr: ast.type.isCall}, statement)
                    ) {
                        i = -1;
                        k = -1;
                        break;
                    }
                    else if (
                        ast.type.matchShape({expr: {expect: {lhs: 'thread', member: 'reuseStackForNextBlock'}}}, statement)
                    ) {
                        k = j;
                    }
                }
                if (i !== -1 && k !== -1) {
                    path.root.getKey('chunks').getKey(i).getKey(k).remove();
                    i = -1;
                }
            }

            if (!afterAnother && beforeAnother) {
                if (!lastChunk ||
                    lastChunk.value.some(statement => (
                        ast.type.matchShape({expr: ast.type.isCall}, statement) &&
                        state.opMap[statement.expr.func.value] &&
                        state.opMap[statement.expr.func.value].op._isHat
                    ))) {
                    path.parent.insertBefore(ast.ifStatement(
                        ast.cast('!', ast.p('thread', 'continuous')),
                        ast.expressionStatement(['return ', 'thread', '.status = ', Thread.STATUS_INTERRUPT])));
                }
                path.parent.insertAfter(ast.storeArg('thread', 'stackFrame._blockExecuteRef', ast.p(ast.p(node.args, 'NEXT_BLOCK'), 'ref')));
                path.replaceWith(ast.cast(ast.p('thread', 'reuseStackForNextBlock'), ast.p(node.args, 'NEXT_STACK')));
            } else if (!beforeAnother) {
                if (info.op._argValues.END_OPERATION === 'vm_end_of_branch') {
                    path.parent.insertBefore(ast.expressionStatement(ast.p('thread', 'popStack()')));
                    path.parent.insertBefore(ast.expressionStatement(ast.p('thread', 'goToNextBlock()')));
                    path.parent.replaceWith(ast.storeArg('thread', 'status', Thread.STATUS_INTERRUPT));
                } else if (info.op._argValues.END_OPERATION === 'vm_end_of_loop_branch') {
                    path.parent.insertBefore(ast.expressionStatement(ast.p('thread', 'popStack()')));
                    path.parent.replaceWith(ast.storeArg('thread', 'status', Thread.STATUS_YIELD));
                } else if (info.op._argValues.END_OPERATION === 'vm_end_of_procedure') {
                    path.parent.replaceWith(ast.ifStatement(ast.op2(
                        '===', ast.p(ast.p('thread', 'stackFrame'), 'endBlockId'), ast.string.quote('vm_end_of_procedure')),
                        [
                            ast.expressionStatement(ast.p('thread', 'popStack()')),
                            ast.expressionStatement(ast.p('thread', 'goToNextBlock()')),
                            ast.storeArg('thread', 'status', Thread.STATUS_INTERRUPT)
                        ],
                        ast.cloneDeep(node)));
                } else {
                    return;
                }
            } else if (afterAnother && beforeAnother) {
                path.parent.insertAfter(ast.storeArg('thread', 'stackFrame._blockExecuteRef', ast.p(ast.p(node.args, 'NEXT_BLOCK'), 'ref')));
                path.replaceWith(ast.cast(ast.p('thread', 'reuseStackForNextBlock'), ast.p(node.args, 'NEXT_STACK')));
            }
        }
    }
    callBlock (node, path, state) {
        const info = state.opMap[node.args.value];
        if (
            node.context.value === 'null' ||
            info && info.op._blockFunctionUnbound.toString().indexOf('this') === -1
        ) path.replaceWith(ast.callFunction(node.func, node.args));
    }
    storeArg (node, path, state) {
        if (node.name.value === '$a_') path.replaceWith(ast.expressionStatement(node.expr));
    }
    checkStatus (node, path, state) {
        const lastSibling = path.parentNode.value[path.key - 1];
        if (
            !lastSibling ||
            ast.type.matchShape({type: 'storeArg', name: name => name !== 'thread'}, lastSibling) ||
            ast.type.matchShape({expr: {func: /^(operator|data|argument)/}}, lastSibling) ||
            ast.type.matchShape({expr: {expect: {
                lhs: 'thread', member: 'reuseStackForNextBlock'}}}, lastSibling) ||
            ast.type.matchShape({expr: ast.type.isFixedOperator}, lastSibling)
        ) path.remove();
    }
    exitCast (node, path, state) {
        if (!state.paths[node.expect.value]) {
            if (Cast[node.expect.value]) {
                if (!state.bindings[node.expect.value]) state.bindings[node.expect.value] = Cast[node.expect.value];
                createHelper(state, path, node.expect.value, ast.p('bindings', node.expect.value));
            }
        }
    }
    exitCast2 (node, path, state) {
        if (!state.paths[node.expect.value]) {
            if (Cast[node.expect.value]) {
                if (!state.bindings[node.expect.value]) state.bindings[node.expect.value] = Cast[node.expect.value];
                createHelper(state, path, node.expect.value, ast.p('bindings', node.expect));
            }
        }
    }
    exitCastArgs (node, path, state) {
        if (!state.paths[node.expect.value]) {
            if (Cast[node.expect.value]) {
                if (!state.bindings[node.expect.value]) state.bindings[node.expect.value] = Cast[node.expect.value];
                createHelper(state, path, node.expect.value, ast.p('bindings', node.expect));
            }
        }
    }
    property (node, path, state) {
        if (ast.type.isString(node.lhs) && ast.type.isString(node.member)) {
            const info = state.opMap[node.lhs.value];
            const storePath = state.paths[node.lhs.value] && state.paths[node.lhs.value][node.member.value];

            if (!storePath) {
                if (info && !info.args[node.member.value]) {
                    if (typeof info.op._argValues[node.member.value] === 'number') {
                        path.replaceWith(info.op._argValues[node.member.value]);
                    } else if (typeof info.op._argValues[node.member.value] === 'string') {
                        path.replaceWith(`'${info.op._argValues[node.member.value]}'`);
                    }
                }
            } else if (info) {
                storePath.refresh();
                if (!ast.type.isStoreArg(storePath.node) || storePath.node.name.value !== node.lhs.value || storePath.node.key.value !== node.member.value) {
                    console.log('couldn\'t refresh');
                    return;
                }

                const storeExpr = storePath.node.expr;

                if (ast.type.isOperator(storeExpr) || ast.type.isLiteral(storeExpr)) {
                    path.replaceWith(ast.cloneDeep(storeExpr));
                    storePath.remove();
                } else {
                    const storeId = `${node.lhs.value}_${node.member.value}`;
                    path.replaceWith(ast.id(storeId));
                    storePath.replaceWith(ast.storeVar(storeId, ast.cloneDeep(storeExpr)));
                }
            }
        }
    }
}
class JSMangle {
    string (node, path, state) {
        if (!state.minimize) return;
        if (path.parent.isArray && path.key > 0 && path.parentNode.value[path.key - 1].value === '.') return;
        if (state.vars[node]) {
            if (!state.mangled[node]) return;
            path.replaceWith(state.mangled[node]);
        }
    }
}
class JSPrinter {
    boolean (node, path, state) {
        state.source += node;
    }
    number (node, path, state) {
        state.source += node;
    }
    string (node, path, state) {
        if (!path.parent.isArray || path.key === 0 || path.parentNode.value[path.key - 1].value !== '.') {
            const varInfo = state.vars[node];
            if (varInfo && varInfo.uses === 1 && varInfo.scope === 'chunks') {
                return path.replaceWith(ast.cloneDeep(varInfo.expr));
            }
        }
        state.source += node;
    }
    checkStatus (node, path, state) {
        path.replaceWith(['if (', 'thread', '.status !== 0) return;']);
    }
    expressionStatement ({expr, used}, path, state) {
        if (used === false && state.minimize) return path.skip();
        if (used === false) return path.replaceWith('/* skipping unused expression statement. */');
        path.replaceWith([expr, ';']);
    }
    ifStatement ({test, expr, ifFalse}, path, state) {
        path.replaceWith(['if (', test, ') ',
            ast.type.isArray(expr) ? ['{ ', expr, ' }'] : expr,
            ast.type.isArray(ifFalse) ?
                ifFalse.value.length > 0 ?
                    [' else ', '{ ', ifFalse, ' }'] :
                    [] :
                [' else ', ifFalse]
        ]);
    }
    storeArg ({name, key, expr}, path, state) {
        const {t} = code;
        path.replaceWith([name, '.', key, ' = ', expr, ';']);
    }
    storeVar ({uses, scope, name, expr}, path, state) {
        const {t} = code;
        if (uses < 0 || uses === 0 && state.minimize) return path.skip();
        if (uses === 1 && state.minimize && scope === 'chunks') return path.skip();
        if (uses === 0) return path.replaceWith(['/* skipping unused var ', name, '. */']);
        if (uses === 1 && scope === 'chunks') return path.replaceWith(['/* inlining var ', name, '. */']);
        path.replaceWith(['var ', name, ' = ', expr, ';', state.minimize ? '' : ` /* uses: ${uses} */`]);
    }
    cast ({expect, value}, path, state) {
        path.replaceWith([expect, '(', value, ')']);
    }
    cast2 ({expect, input1, input2}, path, state) {
        path.replaceWith([expect, '(', input1, ', ', input2, ')']);
    }
    castArgs ({expect, args}, path, state) {
        path.replaceWith([expect, '(',
            args.value.length === 0 ? args : args.value[0],
            args.value.slice(1).map(arg => [', ', arg]),
        ')']);
    }
    property ({lhs, member}, path, state) {
        const {t} = code;
        if (ast.type.isString(member) && /^'[a-zA-Z_\$][\w\$]*(?:\.[a-zA-Z_\$][\w\$]*)*'$/.test(member.value)) {
            path.replaceWith([lhs, '.', member.value.substring(1, member.value.length - 1)]);
        } else if (
            ast.type.isString(member) && /^'.*'$/.test(member.value) ||
            ast.type.isNumber(member) ||
            ast.type.isOperator(member)
        ) {
            path.replaceWith([lhs, '[', member, ']']);
        } else {
            path.replaceWith([lhs, '.', member]);
        }
    }
    ifElse ({test, ifTrue, ifFalse}, path, state) {
        path.replaceWith(['(', test, ' ? ', ifTrue, ' : ', ifFalse, ')']);
    }
    binaryOperator ({operator, input1, input2}, path, state) {
        const {t} = code;
        path.replaceWith(['(', input1, ' ', operator, ' ', input2, ')']);
    }
    callArgs ({func, args}, path, state) {
        path.replaceWith([func, '(',
            args.value.length === 0 ? args : args.value[0],
            args.value.slice(1).map(arg => [', ', arg]),
        ')']);
    }
    callBlock ({context, func, args}, path, state) {
        path.replaceWith([func, '.call(', context, ', ', args, ', ', 'blockUtility', ')']);
    }
    callFunction ({func, args}, path, state) {
        path.replaceWith([func, '(', args, ', ', 'blockUtility', ')']);
    }
    factory ({bindings, dereferences, debugName, chunks}, path, state) {
        path.replaceWith([
            bindings.value.slice().sort((a, b) => (
                (state.mangled[a.name.value] < state.mangled[b.name.value]) * -1 +
                (state.mangled[a.name.value] > state.mangled[b.name.value])
            )),
            'return function ', debugName, ' (args, ', 'blockUtility', ') {',
            dereferences,
            'switch (args.INDEX) {',
            chunks.value.map((chunk, i) => (
                [
                    (
                        i === 0 ||
                        // chunks.value[i - 1].value.some(ast.type.isCheckStatus) ||
                        chunks.value[i - 1].value.some(statement => (
                            ast.type.matchShape({expr: {
                                func: /^vm_(may_continue|do_stack)$|^handlePromise$/
                            }}, statement))) ||
                        chunks.value[i - 1].value.some(statement => (
                            ast.type.matchShape({expr: {
                                expect: {lhs: 'thread', member: 'reuseStackForNextBlock'}
                            }}, statement)))
                    ) ? `case ${i}:` : '',
                    chunk
                ]
            )),
            '}',
            '};'
        ]);
    }
}

const bind = function (map, statements, name, value) {
    map[name] = value;
    statements.push(ast.binding(name));
};

let compileInline;
let compileRefs;
let compilePrint;

class Compiler {}

class CompilerPass {}

class OpcodePass {}

class GeneratorPass {}

let tokens = 0;
let lastCompiled = 0;

const compile = function (blockCached) {
    const firstCommand = blockCached._commandSet.firstCommand;
    const ops = firstCommand._allOps;

    if (ops[0].COMPILED) return;

    let start = (typeof performance === 'undefined' ? Date : performance).now();
    tokens = Math.min(tokens + (start - lastCompiled), 10);

    if (tokens < 0) return;

    const bindings = {};
    const _factoryAST = ast.factory(`${firstCommand.opcode}_${ops.length}`);

    _factoryAST.dereferences.push(
        ast.storeVar('thread', ast.property('blockUtility', 'thread'))
    );
    _factoryAST.dereferences.push(
        ast.storeVar('target', ast.property('blockUtility', 'thread.target'))
    );

    const COMMAND_PARENT_ID = '$a_';

    bind(bindings, _factoryAST.bindings, 'toNumber', Cast.toNumber);
    bind(bindings, _factoryAST.bindings, 'toListIndex', Cast.toListIndex);
    bind(bindings, _factoryAST.bindings, 'LIST_INVALID', Cast.LIST_INVALID);
    bind(bindings, _factoryAST.bindings, 'LIST_ALL', Cast.LIST_ALL);
    bind(bindings, _factoryAST.bindings, 'handlePromise', handlePromise);
    bind(bindings, _factoryAST.bindings, COMMAND_PARENT_ID, {mutation: null, STATEMENT: null});

    const opInfos = [], opMap = [];

    for (let i = ops.length - 1; i > -1; i--) {
        const op = ops[i];
        const argValues = op._argValues;
        const parentValues = op._parentValues;
        const func = op._blockFunctionUnbound;
        const context = op._blockFunctionContext;

        const id = `$a${i}`;
        let parentId = op._parentOffset ? `$a${i + op._parentOffset}` : COMMAND_PARENT_ID;
        const contextId = context ? findId(bindings, context, context.constructor.name, 'ctx_') : 'null';
        const functionId = op.opcode;

        bind(bindings, _factoryAST.bindings, id, argValues);
        if (typeof bindings[functionId] !== 'function') {
            bind(bindings, _factoryAST.bindings, functionId, func);
            if (typeof bindings[contextId] === 'undefined' && context) {
                bind(bindings, _factoryAST.bindings, contextId, context);
            }
        }

        opMap[id] = opInfos[i] = {op, id, parentId, contextId, functionId, args: {}};
        if (op._parentOffset) opMap[parentId].args[op._parentKey] = id;

        if (op._usesPromise) {
            bind(bindings, _factoryAST.bindings, `$b${i}`, op);
            parentId = `$p${i}`;
            bind(bindings, _factoryAST.bindings, parentId, parentValues);
        }

        _factoryAST.chunks.unshift([
            ast.storeArg(
                parentId, op._parentKey,
                ast.callBlock(contextId, functionId, id)
            ),
            op._usesPromise ?
                ast.expressionStatement(ast.callArgs('handlePromise', ['thread', `$b${i}`])) :
                null,
            ast.checkStatus()
        ].filter(Boolean));
    }

    const factoryAST = ast.nodeify(_factoryAST);

    // const transformer = new Transformer();
    if (!compileInline)
    compileInline = new Transformer([
        new JSFindArg(),
        new JSInlineOperators(),
        new InlineDataBlocks(),
        new InlineMathBlocks(),
        new InlineBooleanBlocks(),
        new InlineArgumentBlocks()]);
    if (!compileRefs)
    compileRefs = new Transformer([new JSCountRefs()]);
    if (!compilePrint)
    compilePrint = new Transformer([new JSMangle(), new JSPrinter()]);

    const perf = {
        start: performance.now(),
        end: 0,
        baseline: 0,
        inline: 0,
        count: 0,
        optimized: 0,
        minimized: 0
    };

    // const baselineAST = ast.cloneDeep(factoryAST);

    let last = perf.start;
    perf.baseline = -last;
    const baselineState = {
        source: '',
        minimize: false,
        vars: {},
        varPaths: {}
    };
    // compilePrint.transform(baselineAST, [baselineState, baselineState]);
    const baseline = baselineState.source;
    perf.baseline += (last = performance.now());

    perf.inline = -last;
    const inlineState = {bindings, opInfos, opMap, paths: {}};
    compileInline.transform(factoryAST, [inlineState, inlineState, inlineState, inlineState, inlineState, inlineState]);
    perf.inline += (last = performance.now());

    perf.count = -last;
    const countRefs = {vars: {
        bindings: {uses: 0},
        blockUtility: {uses: 0}
    }, varPaths: {}, strings: [], reassign: {}};
    compileRefs.transform(factoryAST, [countRefs]);
    perf.count += (last = performance.now());

    let mangled = Object.entries(countRefs.vars);
    mangled = mangled.sort(([,{uses}], [,{uses: uses2}]) => uses2 - uses);
    mangled = mangled.reduce((map, [name], index) => {
        map[name] = safe64(index);
        return map;
    }, {});

    Object.entries(mangled).forEach(([name, newName]) => {
        countRefs.vars[newName] = countRefs.vars[name];
        countRefs.varPaths[newName] = countRefs.varPaths[name];
    });

    // const factoryClone = ast.cloneDeep(factoryAST);
    const renderState = {
        source: '',
        vars: countRefs.vars,
        varPaths: countRefs.varPaths,
        nextMangle: mangled.length,
        mangled,
        minimize: false
    };

    // const optimizedAST = ast.cloneDeep(factoryAST);
    perf.optimized = -performance.now();
    // compilePrint.transform(optimizedAST, [renderState, renderState]);
    const optimized = renderState.source;
    perf.optimized += (last = performance.now());

    perf.minimized = -last;
    renderState.source = '';
    renderState.minimize = true;
    compilePrint.transform(ast.cloneDeep(factoryAST), [renderState, renderState]);
    const minimized = renderState.source;
    perf.minimized += (perf.end = last = performance.now());

    (window.AST_COMPILE = (window.AST_COMPILE || [])).push([inlineState, countRefs, renderState, factoryAST]);

    (window.PERF = (window.PERF || {}))[factoryAST.debugName.value] = perf;
    (window.BASELINE = (window.BASELINE || {}))[factoryAST.debugName.value] = baseline;
    (window.OPTIMIZED = (window.OPTIMIZED || {}))[factoryAST.debugName.value] = optimized;
    (window.COMPILED = (window.COMPILED || {}))[factoryAST.debugName.value] = renderState.source;

    const factory = new Function(renderState.minimize ? mangled['bindings'] : 'bindings', renderState.source);

    const _blockFunction = factory(bindings);

    const _allOps = firstCommand._oldOps = firstCommand._allOps;
    const _newOps = firstCommand._allOps = [];
    for (let i = 0; i < _allOps.length; i++) {
        const compileCached = _newOps[i] = new BlockCached(null, {
            id: _allOps[i].id,
            opcode: _allOps[i].opcode,
            fields: {},
            inputs: {},
            mutation: null
        });
        compileCached._blockFunction = compileCached._blockFunctionUnbound = _blockFunction;
        compileCached._argValues.INDEX = _allOps[i]._commandSet.i;

        compileCached.COMPILED = true;
        _allOps[i].COMPILED = true;
    }

    firstCommand.COMPILED = true;

    lastCompiled = (typeof performance === 'undefined' ? Date : performance).now();
    tokens -= lastCompiled - start;
};

const _getCached = function (thread, currentBlockId) {
    return (
        BlocksExecuteCache.getCached(thread.blockContainer, currentBlockId, CommandBlockCached) ||
        BlocksExecuteCache.getCached(
            blockUtility.sequencer.blocks, currentBlockId, CommandBlockCached
        ) ||
        BlocksExecuteCache.getCached(
            blockUtility.sequencer.runtime.flyoutBlocks, currentBlockId, CommandBlockCached
        ) ||
        // No block found: stop the thread; script no longer exists.
        NULL_BLOCK
    );
};

const getCached = function (thread, currentBlockIndex, currentBlockId) {
    const blockCached = (
        thread.stackFrame._blockExecuteRef.block ||
        _getCached(thread, currentBlockId)
    );

    if (blockCached &&
        !blockCached.COMPILED &&
        blockCached._commandSet.firstCommand.count >= blockCached._commandSet.firstCommand._allOps.length) {
        compile(blockCached);
    }

    return blockCached;
};

const EMPTY_MAY_COUNT = [];

const executeOps = function (thread, ops) {
    let i = -1;
    while (thread.status === STATUS_RUNNING) {
        const opCached = ops[++i];
        if (isPromise(opCached._parentValues[opCached._parentKey] = (
            opCached._blockFunctionUnbound.call(
                opCached._blockFunctionContext,
                opCached._argValues, blockUtility
        )))) {
        // if (isPromise(call(ops[++i]))) {
            thread.status = Thread.STATUS_PROMISE_WAIT;
        }
    }
    return ops[i];
};

let profiler = null;
let profilerId = 0;

const PROFILE_WITH_NAMES = false;

const connectProfiler = function (blockCached) {
    blockCached.profiler = profilerId;
    if (blockFunctionProfilerId === -1) {
        blockFunctionProfilerId = profiler.idByName(blockFunctionProfilerFrame);
    }

    const ops = blockCached._allOps;
    for (let i = ops.length - 1; i >= 0; i--) {
        const op = ops[i];
        const mayCount = i + 1 < ops.length ? ops[i + 1].willCount : [];
        op.profiler = profilerId;
        op.mayCount = mayCount;
        op.opsAfter = i + 1 < ops.length ? ops[i + 1].opsAt : 0;
        if (op.profileOpcode) {
            op.opsAt = op.opsAfter + 1;
            const opcode = op.opcode;
            const index = mayCount.findIndex(may => may.opcode === opcode);
            const may = new MayCount(mayCount[index] || {
                opcode,
                frame: profiler.frame(blockFunctionProfilerId, opcode),
                may: 0
            });

            op.willCount = mayCount.slice();
            if (index === -1) {
                op.willCount.push(may);
            } else {
                op.willCount[index] = may;
            }
            // profiler.addSubframe(blockFunctionProfilerId, opcode, may);
        } else {
            op.opsAt = op.opsAfter;
            op.willCount = mayCount;
        }

        // op.count = new MayCount({
        //     opcode: op.opcode,
        //     frame: profiler.frame(blockFunctionProfilerId, null)
        // });
        // profiler.addSubframe(blockFunctionProfilerId, null, op.count);
    }

    // blockCached.count = new MayCount({
    //     opcode: blockCached.opcode,
    //     frame: profiler.frame(blockFunctionProfilerId, null)
    // });
    // profiler.addSubframe(blockFunctionProfilerId, null, blockCached.count);
};

const updateProfiler = function (blockCached, lastBlock) {
    if (blockCached.profiler !== profilerId) connectProfiler(blockCached);

    if (PROFILE_WITH_NAMES) {
        // What may run
        const mayStart = blockCached._allOps[0].willCount;
        // What has not run
        const mayEnd = lastBlock.mayCount;

        let j = 0;
        for (; j < mayEnd.length; j++) {
            mayStart[j].frame.count += mayStart[j].may - mayEnd[j].may;
        }
        for (; j < mayStart.length; j++) {
            mayStart[j].frame.count += mayStart[j].may;
        }
    } else {
        // blockCached.count.frame.count +=
        //     blockCached._allOps[0].opsAt - lastBlock.opsAfter;
    }
};

const executeOuter = function (sequencer, thread) {
    let lastBlock = NULL_BLOCK;

    const isProfiling = sequencer.runtime.profiler !== null;
    if (isProfiling && profiler !== sequencer.runtime.profiler) {
        profiler = sequencer.runtime.profiler;
        profilerId += 1;
    }

    while (thread.status === STATUS_RUNNING) {
        // Current block to execute is the one on the top of the stack.
        const blockCached = getCached(
            thread, thread.stackFrame.blockIndex, thread.pointer || thread.stackFrame.endBlockId);

        thread.stackFrame._blockExecuteRef = blockCached.ref;

        const ops = thread.continuous ?
            blockCached._commandSet.firstCommand._allOps :
            (blockCached._commandSet.firstCommand._oldOps || blockCached._commandSet.firstCommand._allOps);
        let i = blockCached._commandSet.i - 1;
        while (thread.status === STATUS_RUNNING) {
            const opCached = ops[++i];
            opCached._parentValues[opCached._parentKey] = (
                opCached._blockFunction(opCached._argValues, blockUtility));
        }
        lastBlock = ops[i];

        if (i === ops.length - 1) {
            blockCached._commandSet.firstCommand.count++;
        }

        if (isProfiling) updateProfiler(blockCached, lastBlock);

        if (thread.status === Thread.STATUS_INTERRUPT && thread.continuous) {
            thread.status = STATUS_RUNNING;
        } else if (thread.status === Thread.STATUS_PROMISE_WAIT) {
            console.log('promise in', `${blockCached._commandSet.firstCommand.opcode}_${ops.length}`);
            // blockCached._commandSet.firstCommand.count = 0;
        }
    }

    return lastBlock;
};

/**
 * Execute a block.
 * @param {!Sequencer} sequencer Which sequencer is executing.
 * @param {!Thread} thread Thread which to read and execute.
 */
const execute = function (sequencer, thread) {
    // Store old sequencer and thread and reset them after execution.
    const _lastSequencer = blockUtility.sequencer;
    const _lastThread = blockUtility.thread;

    // store sequencer and thread so block functions can access them through
    // convenience methods.
    blockUtility.sequencer = sequencer;
    blockUtility.thread = thread;

    const lastBlock = executeOuter(sequencer, thread);

    if (thread.status === Thread.STATUS_INTERRUPT) {
        thread.status = STATUS_RUNNING;
    } else if (thread.status === Thread.STATUS_PROMISE_WAIT && thread.reported === null) {
        handlePromise(thread, lastBlock);
    }

    // Blocks should glow when a script is starting, not after it has finished
    // (see #1404). Only blocks in blockContainers that don't forceNoGlow should
    // request a glow.
    if (!thread.blockContainer.forceNoGlow) {
        thread.requestScriptGlowInFrame = true;
        thread.blockGlowInFrame = lastBlock.id;
    }

    blockUtility.sequencer = _lastSequencer;
    blockUtility.thread = _lastThread;
};

module.exports = execute;
