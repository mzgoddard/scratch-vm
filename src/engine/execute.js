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
    let hash = 0x00000000;
    for (let i = 0; i < id.length; i++) {
        hash = Math.abs(((hash << 5) - hash + id.charCodeAt(i)) & 0xffffffff);
        // hash = Math.abs((
        //     hash + (id.charCodeAt(i) * Math.pow(31, id.length - i - 1))
        // ) & 0xffffffff);
    }
    return `_${Math.abs(hash)}`;
    // return `_${String(id).replace(/[^_\w]/g, c => c.charCodeAt(0))}`;
};

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

        this._safeId = safeId(cached.id);

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
        return cache[opcode] || (
            function (args, blockUtility) {
                if (cache[opcode]) {
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
                    this._argValues[inputName] = inputCached._shadowValue;
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
}

class CommandBlockCached extends InputBlockCached {
    constructor (blockContainer, cached) {
        super(blockContainer, cached);

        const nextId = blockContainer ?
            blockContainer.getNextBlock(this.id) :
            null;
        const nextCached = blockContainer ? BlocksExecuteCache.getCached(
            blockContainer, nextId, CommandBlockCached
        ) : null;

        this._next = nextCached;

        const mayContinueCached = new InputBlockCached(null, {
            id: cached.id,
            opcode: 'vm_may_continue',
            fields: {},
            inputs: {},
            mutation: null
        });

        mayContinueCached._argValues = {
            EXPECT_STACK: this.id,
            NEXT_STACK: nextId
        };

        this._ops.push(mayContinueCached);
        this._allOps = [
            ...this._ops,
            ...(nextCached ? nextCached._allOps : [])
        ];
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
    id: 'vm_null',
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
            for (const key in node) newNode[key] = ast.cloneDeep(node[key]);
            return newNode;
        }
        return node;
    },

    id (id) {
        return {
            type: 'id',
            typeCode: NODE_CODES.id,
            id
        };
    },
    chunk (statements = []) {
        return {
            type: 'chunk',
            typeCode: NODE_CODES.chunk,
            statements
        };
    },
    expressionStatement (expr) {
        return {
            type: 'expressionStatement',
            typeCode: NODE_CODES.expressionStatement,
            expr
        };
    },
    checkStatus () {
        return {
            type: 'checkStatus',
            typeCode: NODE_CODES.checkStatus,
            expr: null
        };
    },
    storeArg (name, key, expr) {
        return {
            type: 'storeArg',
            typeCode: NODE_CODES.storeArg,
            name,
            key,
            expr
        };
    },
    storeVar (name, expr) {
        return {
            type: 'storeVar',
            typeCode: NODE_CODES.storeVar,
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
            expect,
            value
        };
    },
    cast2 (expect, input1, input2) {
        return {
            type: 'cast2',
            typeCode: NODE_CODES.cast2,
            expect,
            input1,
            input2
        };
    },
    number (value) {
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
            test,
            ifTrue,
            ifFalse
        };
    },
    binaryOperator (operator, input1, input2) {
        return {
            type: 'binaryOperator',
            typeCode: NODE_CODES.binaryOperator,
            operator,
            input1,
            input2
        };
    },
    op2 (operator, input1, input2) {
        return ast.binaryOperator(operator, input1, input2);
    },
    callBlock (context, func, args) {
        return {
            type: 'callBlock',
            typeCode: NODE_CODES.callBlock,
            context,
            func,
            args
        };
    },
    callFunction (func, args) {
        return {
            type: 'callFunction',
            typeCode: NODE_CODES.callFunction,
            func,
            args
        };
    },
    factory (debugName) {
        return {
            type: 'factory',
            typeCode: NODE_CODES.factory,
            debugName,
            bindings: [],
            dereferences: [],
            chunks: []
        };
    },
    type: {
        isLiteral (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].literal;
        },
        isBoolean (node) {
            return typeof node === 'boolean';
        },
        isNumber (node) {
            return typeof node === 'number';
        },
        isString (node) {
            return typeof node === 'string';
        },
        isId (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].id;
        },
        isChunk (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].chunk;
        },
        isStatement (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].statement;
        },
        isExpressionStatement (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].expressionStatement;
        },
        isCheckStatus (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].checkStatus;
        },
        isStore (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].store;
        },
        isStoreArg (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].storeArg;
        },
        isStoreVar (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].storeVar;
        },
        isOperator (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].operator;
        },
        isCast (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].cast;
        },
        isCast2 (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].cast2;
        },
        isProperty (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].property;
        },
        ifElse (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].ifElse;
        },
        isBinaryOperator (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].binaryOperator;
        },
        isCall (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].call;
        },
        isCallBlock (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].callBlock;
        },
        isCallFunction (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].callFunction;
        },
        isFactory (node) {
            return NODE_IS_ANCESTOR[nodeType(node)].factory;
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
            token
        };
    },
    ws () {
        return code.whitespace();
    },
    whitespace () {
        return {
            type: 'whitespace',
            typeCode: NODE_CODES.whitespace
        };
    }
};

const NODE_DATA = {
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
    node: {
        extends: null,
        keys: []
    },
    id: {
        extends: 'node',
        keys: ['id'],
    },
    chunk: {
        extends: 'node',
        keys: ['statements'],
    },
    statement: {
        extends: 'node',
        keys: ['expr'],
    },
    expressionStatement: {
        extends: 'statement',
        keys: ['expr'],
    },
    checkStatus: {
        extends: 'statement',
        keys: [],
    },
    store: {
        extends: 'statement',
        keys: ['expr'],
    },
    storeArg: {
        extends: 'store',
        keys: ['name', 'key', 'expr'],
    },
    storeVar: {
        extends: 'store',
        keys: ['name', 'expr'],
    },
    operator: {
        extends: 'node',
        keys: [],
    },
    cast: {
        extends: 'operator',
        keys: ['expect', 'value'],
    },
    cast2: {
        extends: 'operator',
        keys: ['expect', 'input1', 'input2'],
    },
    property: {
        extends: 'operator',
        keys: ['lhs', 'member'],
    },
    ifElse: {
        extends: 'operator',
        keys: ['test', 'ifTrue', 'ifFalse']
    },
    getVariable: {
        extends: 'operator',
        keys: []
    },
    binaryOperator: {
        extends: 'operator',
        keys: ['operator', 'input1', 'input2'],
    },
    call: {
        extends: 'operator',
        keys: [],
    },
    callBlock: {
        extends: 'call',
        keys: ['func', 'context', 'args'],
    },
    callFunction: {
        extends: 'call',
        keys: ['func', 'args'],
    },
    factory: {
        extends: 'node',
        keys: ['debugName', 'bindings', 'dereferences', 'chunks'],
    },
    token: {
        extends: 'node',
        keys: ['token'],
    },
    whitespace: {
        extends: 'node',
        keys: []
    }
};

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
const NODE_CODE_GET_VARIABLE = NODE_CODES.getVariable;
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
    for (let i = 0; i < NODE_NAMES.length; i++) object[name][NODE_NAMES[i]] = keys.indexOf(NODE_NAMES[i]) > -1;
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

const nodeType = function (node) {
    // node
    if (node != null && node.typeCode > 0) return node.type;
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
    if (node != null && node.typeCode > 0) return node.typeCode;
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
const POPPED = 1;
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
        this.typeCode = NODE_CODE_NULL;
        this.keys = EMPTY_KEYS;
        this.isArray = false;

        // state walking through members
        this.state = AVAILABLE;
        this._index = -1;
        this.children = [];
        this.lastChild = -1;
    }
    set (parent, node) {
        this.state = ACTIVE;
        this.parent = parent;

        this.node = node;
        this.typeCode = nodeCode(node);
        if (this.isArray = (this.typeCode === NODE_CODE_ARRAY)) {
            this.keys = node;
        } else {
            this.keys = NODE_CODE_KEYS[this.typeCode];
        }

        this._index = -1;
        this.lastChild = 0;
    }
    reset () {
        this.state = AVAILABLE;
        this.node = null;
        this._index = 1;
        this.keys = EMPTY_KEYS;
        for (let i = 0; i < this.lastChild; i++) {
            if (this.children[i] && !this.children[i].isAvailable) this.children[i].reset();
        }
    }
    next () {
        if (this.isReview) {
            const activeIndex = this.activeChildIndex;
            if (activeIndex === -1 || activeIndex >= this._index) {
                this.state = ACTIVE;
            } else {
                return;
            }
        }
        if (this._index <= this.keys.length) {
            this._index = Math.min(this._index + 1, this.lastChild + 1);
        }
    }
    _attach (index) {
        if (index >= this.keys.length) throw new Error('Can only attach children that exist');
        let child = this.children[index];
        if (!child) {
            window.NEW_NODES = (window.NEW_NODES | 0) + 1;
            child = this.children[index] = new PathTree(this.depth + 1);
        } else {
            window.REUSED_NODES = (window.REUSED_NODES | 0) + 1;
        }
        if (child.isAvailable) {
            child.set(this, this.node[this.isArray ? index : this.keys[index]]);
            if (index < this._index - 1) child._index = child.keys.length + 1;
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
        // This index will never execute more than once
        const child = this.children[index];
        // if (!child) throw new Error('Cannot detach a unset path');
        if (child && !child.isAvailable) child.reset();
        return this;
    }
    push () {
        return this._attach(this.index);
    }
    pop () {
        if (this._index === Infinity) return this.parent;
        return this.parent.detach(this.keyIndex);
    }
    peekNode () {
        return this.node[this.isArray ? this.index : this.keys[this.index]];
    }

    get isAvailable () {
        return this.state === AVAILABLE;
    }
    get isActive () {
        return this.state >= ACTIVE;
    }
    get isReview () {
        return this.state === REVIEW;
    }
    get isPopped () {
        return this.state === POPPED;
    }
    get atHead () {
        return this._index === -1;
    }
    get inRange () {
        return this.index < this.keys.length;
    }
    get atTail () {
        return this.index === this.keys.length;
    }
    get outOfRange () {
        return this.index > this.keys.length;
    }
    get visitStage () {
        if (this._index === -1) return AT_HEAD;
        const index = this.index;
        const length = this.keys.length;
        if (index < length) return IN_RANGE;
        else if (index === length) return AT_TAIL;
        else return OUT_OF_RANGE;
    }

    get index () {
        if (!this.isReview) return this._index;
        return Math.min(this._index, this.activeChildIndex);
    }
    get activeChildIndex () {
        const max = Math.min(this._index, this.lastChild);
        if (this.isPopped) return max;
        for (let i = 0; i < max; i++) {
            if (this.children[i] && this.children[i].isActive) return i;
        }
        return max;
    }
    get type () {
        return NODE_NAMES[this.typeCode];
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

    changeTree () {
        let parent = this;
        parent.state = REVIEW;
        while (parent.parent && (parent.keyIndex < parent.parent._index)) {
            parent = parent.parent;
            parent.state = REVIEW;
        }
    }

    setKey (key, node) {
        this.assertActive();
        this.changeTree();

        this.node[key] = node;
        const index = this.isArray ? key : this.keys.indexOf(key);
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
            if (index <= this.parent.lastChild) {
                this.parent.lastChild--;
            }
            this.parent.node.splice(index, 1);
            this.parent.children.splice(index, 1);
        } else {
            if (index === this.parent._index - 1) this.parent._index -= 1;
            this.parent.node[this.key] = null;
        }
    }

    replaceWith (node) {
        this.assertActive();
        this.changeTree();
        const index = this.keyIndex;
        if (index === -1) throw new Error('Cannot replace path that is not in parent');
        this.parent.node[this.key] = node;
        this.parent.detach(index);
        return this.parent.attach(index);
    }

    insertChild (index, node) {
        this.assertArray();
        this.changeTree();
        if (index <= this._index) this._index++;
        if (index <= this.lastChild) this.lastChild++;
        this.node.splice(index, 0, node);
        this.children.splice(index, 0, null);
        return this.attach(index);
    }
    prependChild (node) {
        return this.insertChild(0, node);
    }
    appendChild (node) {
        return this.insertChild(this.keys.length, node);
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

const index = function (path) {
    if (!path.isReview) return path._index;
    return Math.min(path._index, path.activeChildIndex);
}
const activeChildIndex = function (path) {
    const max = Math.min(path._index, path.lastChild);
    if (path.isPopped) return max;
    for (let i = 0; i < max; i++) {
        if (path.children[i] && path.children[i].isActive) return i;
    }
    return max;
}
const atHead = function (path) {
    return path._index === -1;
}
const inRange = function (path) {
    return index(path) < path.keys.length;
}
const atTail = function (path) {
    return index(path) === path.keys.length;
}
const outOfRange = function (path) {
    return index(path) > path.keys.length;
}
const visitStage = function (path) {
    if (path._index === -1) return AT_HEAD;
    const index_ = index(path);
    const length = path.keys.length;
    if (index_ < length) return IN_RANGE;
    else if (index_ === length) return AT_TAIL;
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
const visit = function (node, path, visitFunctions) {
    for (let j = 0; j < visitFunctions.length && path.isActive && node === path.node; j += 2) {
        visitFunctions[j](node, path, visitFunctions[j + 1]);
    }
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

        this.path.node = {root};
        this.path.keys = ['root'];
        this.path.lastChild = 0;
        this.path._index = -1;
        this.path.state = ACTIVE;
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
                node = path.node;
                if (willEnter[path.typeCode]) visit(node, path, enter[path.typeCode]);
                if (node === path.node) path.next();
                if (!atTail(path)) break;
            case AT_TAIL:
                node = path.node;
                if (willExit[path.typeCode]) visit(node, path, exit[path.typeCode]);
                if (node !== path.node) break;
            case OUT_OF_RANGE:
                do {
                    path = path.pop();
                } while (path.depth > -1 && (outOfRange(path) || (atTail(path) && !willExit[path.typeCode])));
                if (path.depth === -1 && atTail(path)) run = false;
            }
        }
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
        if (!state.vars[node.name]) {
            node.uses = 0;
            state.vars[node.name] = node;
        } else {
            node.uses = -1;
        }
    }
    checkStatus (node, path, state) {
        const refNode = state.vars.thread;
        if (refNode) refNode.uses++;
    }
}
class JSFindArg {
    exitStoreArg (node, path, state) {
        state.paths[node.name] = state.paths[node.name] || {};
        state.paths[node.name][node.key] = path;
    }
}
const findArg = new JSFindArg();
const createHelper = function (state, path, name, body) {
    state.paths[name] = path.root.getKey('bindings').appendChild(ast.storeVar(name, body));
};
class JSInlineOperators {
    call (node, path, state) {
        const info = state.opMap[node.args];
        if (info && info.op.opcode === 'vm_may_continue') {
            let chunkPath = path.parent;
            while (chunkPath.type !== 'array') {
                chunkPath = chunkPath.parent;
            }
            const chunkParent = chunkPath.parentNode;
            const chunkIndex = chunkPath.key;

            const afterAnother = chunkParent.some((chunk, index) => (
                index < chunkIndex &&
                chunk.some(statement => ast.type.isCall(statement.expr) && statement.expr.func === 'vm_may_continue')
            ));
            if (!afterAnother) return;
            const beforeAnother = chunkParent.some((chunk, index) => (
                index > chunkIndex &&
                chunk.some(statement => ast.type.isCall(statement.expr) && statement.expr.func === 'vm_may_continue')
            ));
            if (!beforeAnother) return;

            const lastChunk = chunkParent[chunkIndex - 1];
            if (!lastChunk) return;

            let i = lastChunk.length - 1;
            for (; i >= 0; i--) {
                const statement = lastChunk[i];
                if (ast.type.isCheckStatus(statement)) continue;
                if (
                    ast.type.isStatement(statement) &&
                    !(
                        ast.type.isLiteral(statement.expr) ||
                        ast.type.isProperty(statement.expr) ||
                        ast.type.isBinaryOperator(statement.expr) ||
                        ast.type.isCast(statement.expr) ||
                        ast.type.isCast2(statement.expr)
                    )
                ) return;
            }
            if (i < 0) {
                path.replaceWith(ast.cast(ast.p('thread', 'reuseStackForNextBlock'), ast.p(node.args, 'NEXT_STACK')));
                return;
            }
        }
        if (info && /^argument/.test(info.op.opcode)) {
            path = path.replaceWith(ast.cast2('definedOr', ast.cast2('getParam', 'thread', ast.p(node.args, 'VALUE')), 0));
        }
        if (info && /^operator_(add|subtract|multiply|divide)/.test(info.op.opcode)) {
            const store1Id = ast.property(node.args, 'NUM1');
            const store2Id = ast.property(node.args, 'NUM2');

            let operator = '+';
            if (info.op.opcode === 'operator_subtract') operator = '-';
            if (info.op.opcode === 'operator_multiply') operator = '*';
            if (info.op.opcode === 'operator_divide') operator = '/';

            path = path.replaceWith(ast.binaryOperator(operator, ast.cast('toNumber', store1Id), ast.cast('toNumber', store2Id)));
        }
        if (info && /^operator_(lt|equals|gt)/.test(info.op.opcode)) {
            let operator = '<';
            if (info.op.opcode === 'operator_equals') operator = '===';
            if (info.op.opcode === 'operator_gt') operator = '>';
            return path.replaceWith(ast.op2(operator,
                ast.cast2('compare', ast.p(node.args, 'OPERAND1'), ast.p(node.args, 'OPERAND2')),
                0
            ));
        }
        if (info && /^operator_(and|or)/.test(info.op.opcode)) {
            let operator = '&&';
            if (info.op.opcode === 'operator_or') operator = '||';
            return path.replaceWith(ast.op2(operator,
                ast.cast('toBoolean', ast.p(node.args, 'OPERAND1')),
                ast.cast('toBoolean', ast.p(node.args, 'OPERAND2'))));
        }
        if (info && info.op.opcode === 'operator_not') {
            return path.replaceWith(ast.cast('!', ast.cast('toBoolean', ast.p(node.args, 'OPERAND'))));
        }
        if (info && info.op.opcode === 'operator_round') {
            return path.replaceWith(ast.math('round', ast.number(ast.p(node.args, 'NUM'))));
        }
        if (info && info.op.opcode === 'operator_mod') {
            const NUM1 = ast.number(ast.property(node.args, 'NUM1'));
            const NUM2 = ast.number(ast.property(node.args, 'NUM2'));

            path = path.replaceWith(ast.cast2('scratchMod', NUM1, NUM2));
        }
        if (info && info.op.opcode === 'operator_mathop') {
            const operator = Cast.toString(info.op._argValues.OPERATOR).toLowerCase();
            const NUM = ast.number(ast.property(node.args, 'NUM'));
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
                return path.replaceWith(ast.binaryOperator('/', ast.binaryOperator('*', ast.math(operator, NUM), 180), ast.property('Math', 'PI')));
            case 'log':
                return path.replaceWith(ast.binaryOperator('/', ast.math('log', NUM), ast.property('Math', 'LN10')));
            case '10 ^':
                return path.replaceWith(ast.math2('pow', 10, NUM));
            case 'sin':
            case 'cos':
                // round10(Math.sin((Math.PI * NUM) / 180))
                return path.replaceWith(
                    ast.cast('round10', ast.math(operator,
                        ast.op2('/',
                            ast.op2('*', ast.p('Math', 'PI'), NUM),
                            180)
                    ))
                );
            case 'tan':
                return path.replaceWith(ast.cast('scratchTan', NUM));
            }
        }
        if (info && info.op.opcode === 'data_variable') {
            const {id, name} = info.op._argValues.VARIABLE;
            const dataId = `data_${safeId(name)}`;
            path.parent.insertBefore(ast.storeVar(dataId, ast.p('target', `lookupOrCreateVariable('${id}', '${name}')`)));
            path = path.replaceWith(ast.property(dataId, 'value'));
        }
        if (info && info.op.opcode === 'data_setvariableto') {
            const {id, name} = info.op._argValues.VARIABLE;
            const dataId = `data_${safeId(name)}`;
            let parentPath = path.parent;
            // Support cloud
            // if (variable.isCloud) {
            //     util.ioQuery('cloud', 'requestUpdateVariable', [variable.name, args.VALUE]);
            // }
            // parentPath.insertAfter(
            //     ast.ifStatement(
            //         ast.property(dataId, 'isCloud'),
            //         ast.callArgs(ast.property('blockUtility', 'ioQuery'), [
            //             `'cloud'`,
            //             `'requestUpdateVariable'`,
            //             ast.array([`'${name}'`, ast.property(node.args, 'VALUE')])
            //         ])));
            parentPath.insertBefore(ast.storeVar(dataId, ast.p('target', `lookupOrCreateVariable('${id}', '${name}')`)));
            parentPath.replaceWith(ast.storeArg(dataId, 'value', ast.p(node.args, 'VALUE')));
        }
        if (info && info.op.opcode === 'data_itemoflist') {
            const {id, name} = info.op._argValues.LIST;
            const dataId = `data_list_${safeId(name)}`;
            const indexId = `data_index_${node.args}_${safeId(name)}`;
            const {op2, ifElse, p, storeVar, cast2} = ast;
            let parentPath = path.parent;
            // var dataId = target.lookupOrCreateList('id', 'name')
            parentPath.insertBefore(storeVar(
                dataId,
                p('target', `lookupOrCreateList('${id}', '${name}')`)
            ));
            // var indexId = toListIndex(args.INDEX, dataId.value.length)
            parentPath.insertBefore(storeVar(
                indexId,
                cast2('toListIndex', p(node.args, 'INDEX'), p(p(dataId, 'value'), 'length'))
            ));
            // indexId === LIST_INVALID ? '' dataId.value[indexId - 1]
            path = path.replaceWith(ifElse(
                op2('===', indexId, 'LIST_INVALID'),
                `''`,
                // dataId.value[indexId - 1]
                p(p(dataId, 'value'), op2('-', indexId, 1))
            ));
        }
    }
    callBlock (node, path, state) {
        const info = state.opMap[node.args];
        if (
            node.context === 'null' ||
            info && info.op._blockFunctionUnbound.toString().indexOf('this') === -1
        ) path.replaceWith(ast.callFunction(node.func, node.args));
    }
    storeArg (node, path, state) {
        if (node.name === 'a_') path.replaceWith(ast.expressionStatement(node.expr));
    }
    checkStatus (node, path, state) {
        const lastSibling = path.parentNode[path.key - 1];
        if (
            !lastSibling ||
            ast.type.isStoreArg(lastSibling) && lastSibling.key !== 'STATEMENT' ||
            ast.type.isCall(lastSibling.expr) && /^(operator|data|argument)/.test(lastSibling.expr.func) ||
            ast.type.isProperty(lastSibling.expr)
        ) path.remove();
    }
    exitCast (node, path, state) {
        if (node.expect === 'toNumber' && (
            typeof node.value === 'number' ||
            ast.type.isBinaryOperator(node.value) && ['+', '-', '*', '<', '===', '>', '&&', '||'].indexOf(node.value.operator) ||
            ast.type.isCast(node.value) && ast.type.isProperty(node.value.expect) &&
                node.value.expect.lhs === 'Math' && ['abs', 'floor', 'ceil', 'sin', 'cos', 'tan', 'pow'].indexOf(node.value.expect.member) > -1 ||
            ast.type.isCast(node.value) && ['round10', 'scratchTan'].indexOf(node.value.expect) > -1 ||
            ast.type.isCast2(node.value) && ['scratchMod'].indexOf(node.value.expect) > -1
        )) return path.replaceWith(node.value);
        if (node.expect === 'toNumber' && (
            typeof node.value === 'string' && !isNan(Number(node.value.substring(1, node.value.length - 1)))
        )) return path.replaceWith(Number(node.value.substring(1, node.value.length - 1)));
        if (node.expect === 'toNumber' && (
            typeof node.value === 'string' && /^'.*'$/.test(node.value) && !isNan(Number(node.value.substring(1, node.value.length - 1)))
        )) return path.replaceWith(Number(node.value.substring(1, node.value.length - 1)));

        if (!state.paths[node.expect]) {
            if (Cast[node.expect]) {
                if (!state.bindings[node.expect]) state.bindings[node.expect] = Cast[node.expect];
                createHelper(state, path, node.expect, ast.p('bindings', node.expect));
            }
            if (node.expect === 'round10') {
                createHelper(state, path, 'round10',
                    'function (value) {return (value + (value % 1e-10) - ((2 * value) % 1e-10));}'
                );
            }
            if (node.expect === 'scratchTan') {
                createHelper(state, path, 'scratchTan', [
                    'function (value) {return (',
                        '(Math.abs(value + 180) % 180 === 90)',
                        'Math.sign((value + 360) % 360 - 180) * Infinity',
                        ast.cast('round10', 'Math.sin((Math.PI * value) / 180)'),
                    ');}'
                ]);
            }
            if (node.expect === 'scratchMod1') {
                // (NUM1 % 1) + (NUM1 < 0)
                createHelper(state, path, 'scratchMod1', [
                    'function (n) {return (n % 1) + (n < 0);}'
                ]);
            }
        }
    }
    exitCast2 (node, path, state) {
        if (node.expect === 'getParam' && node.input1 === 'thread' && ast.type.isString(node.input2)) {
            return path.replaceWith(ast.p(ast.p('thread', 'stackFrame.params'), node.input2));
        }
        if (node.expect === 'scratchMod' && ast.type.isNumber(node.input2) && node.input2 === 1) {
            return path.replaceWith(ast.cast('scratchMod1', node.input1));
        }

        if (!state.paths[node.expect]) {
            if (Cast[node.expect]) {
                if (!state.bindings[node.expect]) state.bindings[node.expect] = Cast[node.expect];
                createHelper(state, path, node.expect, ast.p('bindings', node.expect));
            }
            if (node.expect === 'definedOr') {
                createHelper(state, path, 'definedOr', [
                    'function (v, d) {return typeof v === \'undefined\' ? d : v;}'
                ]);
            }
            if (node.expect === 'getParam') {
                createHelper(state, path, 'getParam', [
                    'function (t, k) {return t.stackFrame.params[k];}'
                ]);
            }
            if (node.expect === 'scratchMod') {
                // (NUM1 % NUM2) + ((NUM1 * NUM2 < 0) * NUM2)
                createHelper(state, path, 'scratchMod', [
                    'function (n, m) {return (n % m) + ((n * m < 0) * m);}'
                ]);
            }
        }
    }
    property (node, path, state) {
        if (typeof node.lhs === 'string' && typeof node.member === 'string') {
            const info = state.opMap[node.lhs];
            const storePath = state.paths[node.lhs] && state.paths[node.lhs][node.member];

            if (!storePath) {
                if (info && !info.args[node.member]) {
                    if (typeof info.op._argValues[node.member] === 'number') {
                        path.replaceWith(info.op._argValues[node.member]);
                    } else if (typeof info.op._argValues[node.member] === 'string') {
                        path.replaceWith(`'${info.op._argValues[node.member]}'`);
                    }
                }
            } else if (info) {
                // const storePath = new Path(path).goTo(storePathArray);
                storePath.refresh();
                if (!ast.type.isStoreArg(storePath.node) || storePath.node.name !== node.lhs || storePath.node.key !== node.member) {
                    return;
                }

                const storeExpr = storePath.node.expr;

                if (ast.type.isOperator(storeExpr)) {
                    path.replaceWith(ast.cloneDeep(storeExpr));
                    storePath.remove();
                } else {
                    const storeId = `${node.lhs}_${node.member}`;
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
        if (typeof path.key === 'number' && path.parentNode[path.key - 1] === '.') return;
        if (state.vars[node]) {
            if (!state.mangled[node]) {
                state.mangled[node] = `m${state.nextMangle++}`;
            }
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
        state.source += node;
    }
    checkStatus (node, path, state) {
        path.replaceWith(['if (', 'thread', '.status !== 0) return;']);
    }
    expressionStatement ({expr}, path, state) {
        path.replaceWith([expr, ';']);
    }
    storeArg ({name, key, expr}, path, state) {
        const {t} = code;
        path.replaceWith([name, '.', key, ' = ', expr, ';']);
    }
    storeVar ({uses, name, expr}, path, state) {
        const {t} = code;
        if (uses < 0 || uses === 0 && state.minimize) return path.skip();
        if (uses === 0) return path.replaceWith(['/* skipping unused var ', name, '. */']);
        path.replaceWith(['var ', name, ' = ', expr, ';', state.minimize ? '' : ` /* uses: ${uses} */`]);
    }
    cast ({expect, value}, path, state) {
        const {t} = code;
        path.replaceWith([expect, '(', value, ')']);
    }
    cast2 ({expect, input1, input2}, path, state) {
        const {t} = code;
        path.replaceWith([expect, '(', input1, ', ', input2, ')']);
    }
    property ({lhs, member}, path, state) {
        const {t} = code;
        if (ast.type.isString(member) && /^'[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*'$/.test(member)) {
            path.replaceWith([lhs, '.', member.substring(1, member.length - 1)]);
        } else if (
            ast.type.isString(member) && /^'.*'$/.test(member) ||
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
    callBlock ({context, func, args}, path, state) {
        path.replaceWith([func, '.call(', context, ', ', args, ', ', 'blockUtility', ')']);
    }
    callFunction ({func, args}, path, state) {
        path.replaceWith([func, '(', args, ', ', 'blockUtility', ')']);
    }
    factory ({bindings, dereferences, debugName, chunks}, path, state) {
        path.replaceWith([
            bindings,
            'return function ', debugName, ' (_, ', 'blockUtility', ') {',
            dereferences,
            chunks,
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

const compile = function (blockCached) {
    const ops = blockCached._allOps;

    let start = Date.now();

    const bindings = {};
    const factoryAST = ast.factory(`${blockCached.opcode}_${ops.length}`);

    factoryAST.dereferences.push(
        ast.storeVar('thread', ast.property('blockUtility', 'thread'))
    );
    factoryAST.dereferences.push(
        ast.storeVar('target', ast.property('blockUtility', 'thread.target'))
    );

    const COMMAND_PARENT_ID = 'a_';

    bind(bindings, factoryAST.bindings, 'toNumber', Cast.toNumber);
    bind(bindings, factoryAST.bindings, 'toListIndex', Cast.toListIndex);
    bind(bindings, factoryAST.bindings, 'LIST_INVALID', Cast.LIST_INVALID);
    bind(bindings, factoryAST.bindings, COMMAND_PARENT_ID, {mutation: null, STATEMENT: null});

    const opInfos = [], opMap = [];

    for (let i = ops.length - 1; i > -1; i--) {
        const op = ops[i];
        const argValues = op._argValues;
        const parentValues = op._parentValues;
        const func = op._blockFunctionUnbound;
        const context = op._blockFunctionContext;

        const id = `a${i}`;
        const parentId = op._parentOffset ? `a${i + op._parentOffset}` : COMMAND_PARENT_ID;
        // const id = `${op.opcode}_${op._safeId}`;
        // const parentId = op._parentSafeId ? `${op._parentOpcode}_${op._parentSafeId}` : COMMAND_PARENT_ID;
        const contextId = context ? findId(bindings, context, context.constructor.name, 'ctx_') : 'null';
        const functionId = op.opcode;

        bind(bindings, factoryAST.bindings, id, argValues);
        if (typeof bindings[functionId] !== 'function') {
            bind(bindings, factoryAST.bindings, functionId, func);
            if (typeof bindings[contextId] === 'undefined' && context) {
                bind(bindings, factoryAST.bindings, contextId, context);
            }
        }

        opMap[id] = opInfos[i] = {op, id, parentId, contextId, functionId, args: {}};
        if (op._parentOffset) opMap[parentId].args[op._parentKey] = id;

        factoryAST.chunks.unshift([
            ast.storeArg(
                parentId, op._parentKey,
                ast.callBlock(contextId, functionId, id)
            ),
            ast.checkStatus()
        ]);
    }

    // const transformer = new Transformer();
    if (!compileInline) compileInline = new Transformer([new JSFindArg(), new JSInlineOperators()]);
    if (!compileRefs) compileRefs = new Transformer([new JSCountRefs()]);
    if (!compilePrint) compilePrint = new Transformer([new JSMangle(), new JSPrinter()]);

    const perf = {
        start: performance.now(),
        end: 0,
        baseline: 0,
        inline: 0,
        count: 0,
        optimized: 0,
        minimized: 0
    };

    const baselineAST = ast.cloneDeep(factoryAST);

    let last = perf.start;
    perf.baseline = -last;
    const baselineState = {
        source: '',
        minimize: false
    };
    compilePrint.transform(baselineAST, [baselineState, baselineState]);
    const baseline = baselineState.source;
    perf.baseline += (last = performance.now());

    perf.inline = -last;
    const inlineState = {bindings, opInfos, opMap, paths: {}};
    compileInline.transform(factoryAST, [inlineState, inlineState]);
    perf.inline += (last = performance.now());

    perf.count = -last;
    const countRefs = {vars: {
        bindings: {uses: 0},
        blockUtility: {uses: 0}
    }, strings: []};
    compileRefs.transform(factoryAST, [countRefs]);
    perf.count += (last = performance.now());

    let mangled = Object.entries(countRefs.vars);
    mangled = mangled.sort(([,{uses}], [,{uses: uses2}]) => uses2 - uses);
    mangled = mangled.reduce((map, [name], index) => {
        if (!map[name]) map[name] = `m${index}`;
        return map;
    }, {
        bindings: 'b',
        blockUtility: 'u'
    });

    const factoryClone = ast.cloneDeep(factoryAST);
    const renderState = {
        source: '',
        vars: countRefs.vars,
        nextMangle: mangled.length,
        mangled,
        minimize: false
    };

    const optimizedAST = ast.cloneDeep(factoryAST);
    perf.optimized = -performance.now();
    compilePrint.transform(optimizedAST, [renderState, renderState]);
    const optimized = renderState.source;
    perf.optimized += (last = performance.now());

    perf.minimized = -last;
    renderState.source = '';
    renderState.minimize = true;
    compilePrint.transform(ast.cloneDeep(factoryAST), [renderState, renderState]);
    const minimized = renderState.source;
    perf.minimized += (perf.end = last = performance.now());

    (window.AST_COMPILE = (window.AST_COMPILE || [])).push([inlineState, countRefs, renderState, factoryClone, factoryAST]);

    const factory = new Function(renderState.minimize ? mangled['bindings'] : 'bindings', renderState.source);

    const compileCached = new BlockCached(null, {
        id: blockCached.id,
        opcode: 'vm_compiled',
        fields: {},
        inputs: {},
        mutation: null
    });
    compileCached._blockFunction = compileCached._blockFunctionUnbound = factory(bindings);
    (window.PERF = (window.PERF || {}))[compileCached._blockFunctionUnbound.name] = perf;
    (window.BASELINE = (window.BASELINE || {}))[compileCached._blockFunctionUnbound.name] = baseline;
    (window.OPTIMIZED = (window.OPTIMIZED || {}))[compileCached._blockFunctionUnbound.name] = optimized;
    (window.COMPILED = (window.COMPILED || {}))[compileCached._blockFunctionUnbound.name] = factory.toString();

    blockCached._allOps = [compileCached];
};

const getCached = function (thread, currentBlockId) {
    const blockCached = (
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
    if (thread.continuous && blockCached.count++ === 100) compile(blockCached);
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
            thread, thread.pointer || thread.stackFrame.endBlockId);

        const ops = blockCached._allOps;
        let i = -1;
        while (thread.status === STATUS_RUNNING) {
            const opCached = ops[++i];
            opCached._parentValues[opCached._parentKey] = (
                opCached._blockFunction(opCached._argValues, blockUtility));
        }
        lastBlock = ops[i];

        if (isProfiling) updateProfiler(blockCached, lastBlock);

        if (thread.status === Thread.STATUS_INTERRUPT && thread.continuous) {
            thread.status = STATUS_RUNNING;
        } else if (thread.status === Thread.STATUS_PROMISE_WAIT) {
            blockCached.count = 0;
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
