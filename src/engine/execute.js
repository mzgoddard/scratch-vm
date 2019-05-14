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
    return `_${String(id).replace(/[^_\w]/g, '_')}`;
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
const camelCase = memoify(str => `${str[0].toLowerCase()}${str.substring(1)}`);
const sansPrefix = memoify(str => camelCase(str.substring(2)));
const titleCase = memoify(str => `${str[0].toUpperCase()}${str.substring(1)}`)
const enterTitleCase = memoify(str => `enter${titleCase(str)}`);
const exitTitleCase = memoify(str => `exit${titleCase(str)}`);

class JSNode {
    constructor () {
        Object.defineProperty(this, 'type', {
            enumerable: false,
            writeable: false,
            value: this.type
        });
    }
    get type () {
        return sansPrefix(this.constructor.name);
    }
    toString () {
        return '';
    }
}
class JSId extends JSNode {
    constructor ({id}) {
        super();
        this.id = id;
    }
}
class JSChunk extends JSNode {
    constructor ({statements}) {
        super();
        this.statements = statements;
    }
    toString () {
        return this.statements.join('');
    }
}
class JSStatement extends JSNode {
    constructor (expr) {
        super();
        this.expr = expr;
    }
}
class JSExpressionStatement extends JSStatement {
    toString () {
        return `${this.expr};`;
    }
}
class JSCheckStatus extends JSStatement {
    constructor () {
        super(['thread']);
    }
    toString () {
        return 'if (thread.status !== 0) return;';
    }
}
class JSStore extends JSStatement {
    constructor (expr) {
        super(expr);
    }
}
class JSStoreArg extends JSStore {
    constructor ({expr, name, key}) {
        super(expr);
        this.name = name;
        this.key = key;
    }
    toString () {
        return `${this.name}.${this.key} = ${this.expr};`;
    }
}
class JSStoreVar extends JSStore {
    constructor ({uses = 0, expr, name}) {
        super(expr);
        this.uses = uses;
        this.name = name;
    }
    toString () {
        if (this.uses === 0) return '';
        return `var ${this.name} = ${this.expr};`;
    }
}
class JSOperator extends JSNode {}
class JSCast extends JSNode {
    constructor ({expect, value}) {
        super();
        this.expect = expect;
        this.value = value;
    }
}
class JSProperty extends JSOperator {
    constructor ({lhs, member}) {
        super();
        this.lhs = lhs;
        this.member = member;
    }
    toString () {
        return `${this.lhs}.${this.member}`;
    }
}
class JSGetVariable extends JSOperator {}
class JSBinaryOperator extends JSOperator {
    constructor ({operator, input1, input2}) {
        super();
        this.operator = operator;
        this.input1 = input1;
        this.input2 = input2;
    }
    toString () {
        return `${this.input1} ${this.operator} ${this.input2}`;
    }
}
class JSCall extends JSOperator {}
class JSCallBlock extends JSCall {
    constructor ({context, func, args}) {
        super();
        this.context = context;
        this.func = func;
        this.args = args;
    }
    toString () {
        return `${this.func}.call(${this.context}, ${this.args}, blockUtility)`;
    }
}
class JSCallFunction extends JSCall {
    constructor ({func, args}) {
        super();
        this.func = func;
        this.args = args;
    }
    toString () {
        return `${this.func}(${this.args}, blockUtility)`;
    }
}
class JSFactory extends JSNode {
    constructor ({debugName, bindings = [], dereferences = [], chunks = []}) {
        super();
        this.debugName = debugName;
        this.bindings = bindings;
        this.dereferences = dereferences;
        this.chunks = chunks;
    }
    toString () {
        return [
            ...this.bindings,
            `return function ${this.debugName} (_, blockUtility) {`,
            ...this.dereferences,
            ...this.chunks,
            `};`
        ].join('')
    }
}
const ast = {
    clone (node) {
        if (Array.isArray(node)) {
            return node.map(item => item instanceof JSNode ? item : ast.clone(item));
        } else if (typeof node === 'object' && node) {
            const newNode = {};
            for (const key in node) {
                if (!(node[key] instanceof JSNode)) {
                    newNode[key] = ast.clone(node[key]);
                } else newNode[key] = node[key];
            }
            if (node instanceof JSNode) return new node.constructor(newNode);
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
            if (node instanceof JSNode) return new node.constructor(newNode);
            return newNode;
        }
        return node;
    },

    id (id) {
        return new JSId({id});
    },
    chunk (statements = []) {
        return new JSChunk({statements});
    },
    expressionStatement (expr) {
        return {
            type: 'expressionStatement',
            expr
        };
    },
    checkStatus () {
        return {
            type: 'checkStatus',
            expr: null
        };
    },
    storeArg (name, key, expr) {
        return {
            type: 'storeArg',
            name,
            key,
            expr
        };
    },
    storeVar (name, expr) {
        return {
            type: 'storeVar',
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
            expect,
            value
        };
    },
    cast2 (expect, input1, input2) {
        return {
            type: 'cast2',
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
            test,
            ifTrue,
            ifFalse
        };
    },
    binaryOperator (operator, input1, input2) {
        return {
            type: 'binaryOperator',
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
            context,
            func,
            args
        };
    },
    callFunction (func, args) {
        return {
            type: 'callFunction',
            func,
            args
        };
    },
    factory (debugName) {
        return new JSFactory({debugName});
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
class JSToken extends JSNode {
    constructor ({token}) {
        super();
        this.token = token;
    }
}
class JSWhitespace extends JSNode {}
const code = {
    t (token) {
        return code.token(token);
    },
    token (token) {
        return new JSToken({token});
    },
    ws () {
        return code.whitespace();
    },
    whitespace () {
        return new JSWhitespace();
    }
};

const NODE_TYPES = [
    Boolean,
    Number,
    String,
    Object,
    Array,
    JSId,
    JSChunk,
    JSExpressionStatement,
    JSCheckStatus,
    JSStoreArg,
    JSStoreVar,
    JSCast,
    JSProperty,
    JSBinaryOperator,
    JSCallBlock,
    JSCallFunction,
    JSFactory,

    JSToken,
    JSWhitespace
];

const NODE_DATA = {
    // null: {
    //     extends: null,
    //     keys: []
    // },
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

const NODE_KEYS = Object.entries(NODE_DATA).reduce((object, [name, data]) => {
    object[name] = data.keys;
    return object;
}, {});

const NODE_ANCESTORS = Object.entries(NODE_DATA).reduce((object, [name, data]) => {
    object[name] = [name];
    let _extends = data.extends;
    let parent = NODE_DATA[data.extends];
    while (NODE_DATA[_extends]) {
        object[name].push(_extends);
        _extends = NODE_DATA[_extends].extends;
    }
    return object;
}, {});
NODE_ANCESTORS.null = [];

const NODE_IS_ANCESTOR = Object.entries(NODE_ANCESTORS).reduce((object, [name, keys]) => {
    object[name] = {};
    for (let i = 0; i < NODE_NAMES.length; i++) object[name][NODE_NAMES[i]] = keys.indexOf(NODE_NAMES[i]) > -1;
    return object;
}, {});

const NODE_ENTER_KEYS = Object.entries(NODE_ANCESTORS).reduce((object, [name, keys]) => {
    object[name] = keys.concat(keys.map(enterTitleCase));
    return object;
}, {});
const NODE_EXIT_KEYS = Object.entries(NODE_ANCESTORS).reduce((object, [name, keys]) => {
    object[name] = keys.map(exitTitleCase);
    return object;
}, {});

const EMPTY_KEYS = [];
const nodeKeys = function (node) {
    if (typeof node !== 'object' || node === null) return EMPTY_KEYS;
    else if (Array.isArray(node)) return node;
    return NODE_KEYS[node.type] || Object.keys(node);
};

const earlierPath = function (earlyPath, laterPath, length = Math.min(earlyPath.length, laterPath.length)) {
    let i = 1;
    for (; i < length && earlyPath.pathArray[i] === laterPath.pathArray[i]; i++) {}
    if (i < length) {
        const key = earlyPath.pathArray[i];
        const laterKey = laterPath.pathArray[i];
        if (typeof key === 'number') {
            return key < laterKey;
        } else {
            const parent = earlyPath.parents[i - 1];
            const siblings = nodeKeys(parent);
            return siblings.indexOf(key) < siblings.indexOf(laterKey);
        }
    }
    return earlyPath.length < laterPath.length;
};

class Path {
    constructor (parentPath) {
        const {pathArray, parents} = parentPath;
        this.parentPath = this;
        this.changedNodes = [];
        this.changeIndex = 0;

        this.pathArray = pathArray;

        this.ownsArray = false;
        this.parents = parents;

        if (parentPath instanceof Path) {
            this.parentPath = parentPath.parentPath;
            this.changedNodes = parentPath.changedNodes;

            this.pathArray = parentPath.pathArrayCopy;
            this.parents = parents.slice();
        }
    }
    get length () {
        return this.pathArray.length;
    }
    get parentKey () {
        return this.pathArray[this.length - 2];
    }
    get parentNode () {
        return this.parents[this.length - 2];
    }
    get parent () {
        const parentLength = this.length - 1;
        const parentPath = new Path(this);
        parentPath.pathArray = parentPath.pathArray.slice(0, parentLength);
        parentPath.node = parentPath.parents[parentLength - 1];
        return parentPath;
    }
    get key () {
        return this.pathArray[this.length - 1];
    }
    get node () {
        return this.parents[this.length - 1];
    }
    set node (value) {
        return this.parents[this.length - 1] = value;
    }
    get safeParentNode () {
        const {length} = this;
        if (length === 1) return this.parents;
        return this.parents[length - 2];
    }
    get rootNode () {
        return this.parents[0];
    }
    get pathArrayCopy () {
        if (this.ownsArray) {
            window.GIVE = (window.GIVE | 0) + 1;
            // this.pathArray = this.pathArray.slice();
            this.ownsArray = false;
        } else window.BORROWED = (window.BORROWED | 0) + 1;
        return this.pathArray;
    }
    static clonePath (path) {
        return new Path({})
    }
    static fromRoot (root) {
        return new Path({
            pathArray: ['root'],
            parents: [root]
        });
    }
    static fromPath (path) {
        return new Path(path);
    }
    reset () {
        this.pathArray = ['root'];
        this.ownsArray = false;
        return this;
    }
    addChange (pathArray, node) {
        this.changedNodes[this.parentPath.changeIndex++] = new QueuedEnter(pathArray, node);
    }
    _takePathArray () {
        if (!this.ownsArray) {
            window.TAKE = (window.TAKE | 0) + 1;
            this.pathArray = this.pathArray.slice();
            this.ownsArray = true;
        } else window.OWNS = (window.OWNS | 0) + 1;
    }
    _goTo (i, pathArray) {
        let node = this.parents[i - 1];
        for (; node && i < pathArray.length; i++) {
            node = this.parents[i] = node[pathArray[i]];
        }
        if (!node) return this.reset();
        this.pathArray = pathArray;
        this.ownsArray = false;
        return this;
    }
    mismatchIndex (pathArray) {
        let i = 1;
        for (; i < pathArray.length && this.pathArray[i] === pathArray[i]; i++) {}
        return i;
    }
    goToFast (pathArray) {
        const i = this.mismatchIndex(pathArray);
        if (this.length + i === 2 * pathArray.length) return this;
        return this._goTo(i, pathArray);
    }
    goTo (pathArray) {
        return this._goTo(1, pathArray);
    }
    goToKey (key) {
        // Make a copy of pathArray before changing it.
        const {length} = this.pathArray;
        this._takePathArray();
        this.pathArray[length] = key;
        this.parents[length] = this.parents[length - 1][key];
        return this;
    }
    skip () {
        this.node = null;
    }
    stop () {
        this.pathArray.length = 0;
    }
    setKey (key, newNode) {
        const parentDepth = this.length - 1;
        return this._insert(parentDepth, key, newNode);
    }
    getKey (key) {
        return new Path(this).goToKey(key);
    }
    earlierPath (laterPath) {
        let i = 1;
        const length = Math.min(this.length, laterPath.length);
        for (; i < length && this.pathArray[i] === laterPath.pathArray[i]; i++) {}
        if (i < length) {
            const key = this.pathArray[i];
            const laterKey = laterPath.pathArray[i];
            if (typeof key === 'number') {
                return key < laterKey;
            } else {
                const parent = this.parents[i - 1];
                const siblings = nodeKeys(parent);
                return siblings.indexOf(key) < siblings.indexOf(laterKey);
            }
        }
        return this.length < laterPath.length;
    }
    confirmPath () {
        for (let i = this.length - 1; i > 0; i--) {
            const node = this.parents[i];
            const parent = this.parents[i - 1];
            const parentKey = this.pathArray[i];
            if (parent[parentKey] !== node) {
                if (Array.isArray(parent)) {
                    const newIndex = parent.indexOf(node);
                    if (newIndex === -1) throw new Error('path.node must be a descendent of Path\'s root');
                    this.pathArray[i] = newIndex;
                } else {
                    const newIndex = Object.values(parent).indexOf(node);
                    if (newIndex === -1) throw new Error('path.node must be a descendent of Path\'s root');
                    this.pathArray[i] = Object.keys(parent)[newIndex];
                }
            }
        }
    }
    confirmArrayParent () {
        const parent = this.parentNode;
        if (!Array.isArray(parent)) throw new Error('Must use insertBefore with an array parent');
    }
    confirmArray () {
        const node = this.node;
        if (!Array.isArray(node)) throw new Error('Must use insertBefore with an array node');
    }
    remove () {
        this.confirmPath();
        const parent = this.parentNode;
        const key = this.key;
        if (Array.isArray(parent)) {
            parent.splice(Number(key), 1);
            if (key < parent.length) {
                // Revisit this index. It is a different value now.
                this.addChange(this.pathArrayCopy, parent[key]);
            }
        }
        else parent[key] = null;
        this.node = null;
    }
    replaceWith (newNode) {
        if (this.length === 1) {
            this.parents[0] = newNode;
            this.addChange(this.pathArrayCopy, newNode);
            return new Path(this);
        }
        this.confirmPath();
        this.node = this.parentNode[this.key] = newNode;
        this.addChange(this.pathArrayCopy, newNode);
        return new Path(this);
    }
    _insert (depth, index, newNode) {
        this.confirmPath();
        const parent = this.parents[depth];
        if (Array.isArray(parent)) {
            parent.splice(Number(index), 0, newNode);
            const insertDepth = depth + 1;
            if (this.length > insertDepth && this.pathArray[insertDepth] <= index) {
                this._takePathArray();
                this.pathArray[insertDepth] += 1;
            }
            if (this.parentPath.length > insertDepth && this.parentPath.pathArray[insertDepth] <= index) {
                // confirmPath
                let i = 0;
                const parentPath = this.parentPath
                const parentPathArray = parentPath.pathArray;
                for (; i < insertDepth && parentPathArray[i] === this.pathArray[i]; i++) {}
                if (i === insertDepth) {
                    parentPath._takePathArray();
                    parentPath.pathArray[insertDepth] += 1;
                }
            }
        }
        else parent[index] = newNode;
        const newPathArray = this.pathArray.slice();
        if (depth < newPathArray.length) {
            newPathArray.length = depth + 1;
            newPathArray[depth + 1] = index;
        }
        const newPath = new Path(this).goTo(newPathArray);
        this.addChange(newPathArray, newNode);
        return newPath;
    }
    insertSibling (index, newNode) {
        this.confirmArrayParent();
        const parentDepth = this.length - 2;
        return this._insert(parentDepth, index, newNode);
    }
    insertFirst (newNode) {
        return this.insertSibling(0, newNode);
    }
    insertLast (newNode) {
        const parent = this.parentNode;
        return this.insertSibling(parent.length, newNode);
    }
    insertBefore (newNode) {
        const parentKey = this.key;
        return this.insertSibling(parentKey, newNode);
    }
    insertAfter (newNode) {
        const parentKey = this.key;
        return this.insertSibling(parentKey + 1, newNode);
    }
    insertChild (index, newNode) {
        this.confirmArray();
        const parentDepth = this.length - 1;
        return this._insert(parentDepth, index, newNode);
    }
    prependChild (newNode) {
        return this.insertChild(0, newNode);
    }
    appendChild (newNode) {
        const node = this.node;
        return this.insertChild(node.length, newNode);
    }
}
class Visitor {
    factory () {}
    enterFactory () {}
    exitFactory () {}
}
class QueuedVisit {
    constructor (mode, pathArray, node, keys) {
        this.mode = mode;
        this.pathArray = pathArray;
        this.node = node;
        this.isArray = node === keys;
        this.keys = keys;
        this.keyIndex = 0;
    }
}
const keysFree = [];
let keysFreeIndex = 0;
// const keysFree = NODE_NAMES.reduce((free, key) => {
//     free[key] = [];
//     return free;
// }, {});
class QueuedKeys extends QueuedVisit {
    constructor (pathArray, node, keys) {
        super('enter', pathArray, node, keys);
    }
}
const queuedKeysFromPath = function (path, node, keys) {
    if (keysFreeIndex) {
        const free = keysFree[(keysFreeIndex--) - 1];
        if (path.ownsArray) {
            const pathArray = free.pathArray;
            const _pathArray = path.pathArray;
            const l = _pathArray.length;
            for (let i = 1; i < l; i++) pathArray[i] = _pathArray[i];
            if (pathArray.length > l) pathArray.length = l;
        } else {
            free.pathArray = path.pathArray;
        }
        free.node = node;
        free.isArray = node === keys;
        free.keys = keys;
        free.keyIndex = 0;
        return free;
    } else {
        return new QueuedKeys(path.pathArrayCopy, node, keys);
    }
};
const queuedKeysRelease = function (visit) {
    keysFree[keysFreeIndex++] = visit;
};
const QUEUED_EMPTY_KEYS = [];
class QueuedEnter extends QueuedVisit {
    constructor (pathArray, node) {
        super('enter', pathArray, node, QUEUED_EMPTY_KEYS);
        this.keyIndex = -1;
    }
}
class QueuedExit extends QueuedVisit {
    constructor (pathArray, node) {
        super('exit', pathArray, node, QUEUED_EMPTY_KEYS);
        this.keyIndex = -1;
    }
}
const nodeType = function (node) {
    if (typeof node !== 'object') return typeof node;
    else if (Array.isArray(node)) return 'array';
    else if (node) return node.type || camelCase(node.constructor.name);
    else if (node === null) return 'null';
    return 'unknown';
};
class Transformer {
    constructor () {
        this.path = null;
        this.visitors = null;
        this.states = null;
        this.i = 0;
        this.queueIndex = 0;
        this.queued = null;
        this.isUnchanged = true;
    }
    transform (root, visitors, states) {
        this.i = 0;
        this.queueIndex = 0;
        const queued = this.queued = []
        const path = this.path = Path.fromRoot(root);
        this.cache = {node: {}, keys: {}, enter: {}, exit: {}};
        this.initVisitors(visitors, states);
        this.queue(new QueuedEnter(this.path.pathArrayCopy, root));
        this.isUnchanged = true;
        this.item = null;

        // const visited = new Set();
        while (
            this.queueIndex > 0 && this.queueIndex < 100000 &&
            path.length > 0 && path.length < 100
        ) {
            const key = this.path.key;



            const item = this.item = queued[this.queueIndex - 1];
            // if (item.keys.length === 0 && item.keyIndex > 0) {
            //     this.queueIndex--;
            //     continue;
            // } else if (item.keyIndex >= item.keys.length) {
            //     queuedKeysRelease(item);
            //     this.queueIndex--;
            //     continue;
            // }
            // if (item.keyIndex > item.keys.length && item.keys.length === 0) {
            // if (item.keyIndex > item.keys.length && item.keyIndex === 0) {
            //     this.queueIndex--;
            //     continue;
            // } else
            if (item.keyIndex >= item.keys.length && item.keyIndex > 0) {
                queuedKeysRelease(item);
                this.queueIndex--;
                continue;
            } else if (item.keyIndex >= item.keys.length) {
                this.queueIndex--;
                continue;
            }

            if (this.isUnchanged) {
                const mismatch = path.mismatchIndex(item.pathArray);
                if ((item.keys.length > 0 && path.length - mismatch > 1) ||
                    path.length - mismatch > 0) {
                    path._goTo(mismatch, item.pathArray);
                }
            } else {
                path.goTo(item.pathArray);
                this.isUnchanged = true;
            }

            const length = item.pathArray.length;
            if (path.parents[length - 1] !== item.node) {
                // Queued visit is out of date
                this.queueIndex--;
                continue;
            }

            // There are more leaves than branches. Test if we are at a leaf.
            const index = item.keyIndex++;
            if (index > -1) {
                let key = item.isArray ? index : item.keys[index];

                const node = item.node[key];

                // path.goToKey(key);
                path._takePathArray();
                path.pathArray[length] = key;
                path.parents[length] = node;
            }

            if (item.mode === 'enter') this.enter();
            else this.exit();
        }
    }
    getPrototypeAncestry (proto) {
        const ancestry = [];
        while (proto && proto !== Object.prototype) {
            ancestry.push(proto);
            proto = Object.getPrototypeOf(proto);
        }
        return ancestry;
    }
    getAllPropertyNames (proto) {
        const keySet = new Set();
        const protos = this.getPrototypeAncestry(proto);
        for (let i = 0; i < protos.length; i++) {
            const keys = Object.getOwnPropertyNames(protos[i]);
            for (let j = 0; j < keys.length; j++) keySet.add(keys[j]);
        }
        return Array.from(keySet);
    }
    initVisitors (visitors, states) {
        this.visitors = visitors || [];
        const visitKeys = this.visitKeys = Object.create(null);
        for (let i = 0; i < visitors.length; i++) {
            const state = states[i];
            const visitor = visitors[i];
            const keys = this.getAllPropertyNames(visitor);
            for (let j = 0; j < keys.length; j++) {
                const key = keys[j];
                if (typeof visitor[keys[j]] === 'function') {
                    visitKeys[key] = (visitKeys[key] || []);
                    visitKeys[key].push(visitor[key], state);
                }
            }
        }
        const visitTypes = this.visitTypes = Object.create(null);
        for (let k = 0; k < NODE_NAMES.length; k++) {
            const typeName = NODE_NAMES[k];
            const typeData = NODE_DATA[typeName];
            const nodeKeys = typeData.keys;
            const enterKeys = NODE_ENTER_KEYS[typeName];
            const exitKeys = NODE_EXIT_KEYS[typeName];

            const typeFunctions = visitTypes[typeName] = {enter: [], exit: [], keys: nodeKeys};

            for (let l = 0; l < enterKeys.length; l++) {
                const visitFunctions = visitKeys[enterKeys[l]];
                if (visitFunctions) typeFunctions.enter.push(...visitFunctions);
            }
            for (let m = 0; m < exitKeys.length; m++) {
                const visitFunctions = visitKeys[exitKeys[m]];
                if (visitFunctions) typeFunctions.exit.push(...visitFunctions);
            }

            // console.log(typeName, enterKeys, exitKeys, typeFunctions, this.visitKeys);
        }
    }
    hasVisitor (key) {
        return Boolean(this.visitKeys[key]);
    }
    queue (queuedVisit) {
        this.queued[this.queueIndex++] = queuedVisit;
    }
    queueChanges () {
        const length = this.path.changeIndex;
        if (length > 0) {
            const changedNodes = this.path.changedNodes;
            for (let i = 0; i < length; i++) {
                if (earlierPath(changedNodes[i].pathArray, this.thePath.pathArray)) {
                    this.queued[this.queueIndex++] = changedNodes[i];
                }
            }
            this.path.changeIndex = 0;
            this.isUnchanged = false;
        }
    }
    visit (visitFunctions) {
        const {path} = this;
        const node = path.node;
        for (let j = 0; node === path.node && j < visitFunctions.length; j += 2) {
            visitFunctions[j](node, path, visitFunctions[j + 1]);
        }
    }
    nodeType (node) {
        if (typeof node !== 'object') return typeof node;
        else if (Array.isArray(node)) return 'array';
        else if (node) return node.type || camelCase(node.constructor.name);
        else if (node === null) return 'null';
        return 'unknown';
    }
    nodeKeys (node) {
        return nodeKeys(node);

        if (typeof node !== 'object' || node === null) return QUEUED_EMPTY_KEYS;
        // else if (node instanceof JSNode && node.keys) return node.keys;
        // else if (Array.isArray(node)) return Array.from(node.keys());
        // Array have "psuedo" keys.
        else if (Array.isArray(node)) return node;
        return NODE_KEYS[node.type] || [];

        const cacheKey = node.type || node.constructor.name;
        const cached = this.cache.node[cacheKey];
        if (cached) return cached;

        const keys = Object.keys(node);
        window.CACHE_SET_NODE_KEYS = (window.CACHE_SET_NODE_KEYS | 0) + 1;
        this.cache.node[cacheKey] = keys;

        // if (node instanceof JSNode) Object.getPrototypeOf(node).keys = keys;

        return keys;
    }
    visitorKeys (node) {
        if (typeof node !== 'object') return [typeof node];
        else if (node === null) return ['null'];
        else if (Array.isArray(node)) return ['array'];
        return NODE_ANCESTORS[node.type] || [camelCase(node.constructor.name)];
        // else if (node instanceof JSNode && node.visitorKeys) return node.visitorKeys;
        // else if (node === null) return ['null'];

        const cacheKey = node.type || node.constructor.name;
        const cached = this.cache.keys[cacheKey];
        if (cached) return cached;

        const keySet = new Set();
        if (typeof node === 'object') {
            const protos = this.getPrototypeAncestry(node)
            for (let i = 0; i < protos.length; i++) {
                if (protos[i].type) keySet.add(protos[i].type);
                else keySet.add(camelCase(protos[i].constructor.name));
            }
        } else keySet.add(typeof node);

        const keys = Array.from(keySet);
        window.CACHE_SET_VISITOR_KEYS = (window.CACHE_SET_VISITOR_KEYS | 0) + 1;
        this.cache.keys[cacheKey] = keys;

        // if (node instanceof JSNode) Object.getPrototypeOf(node).visitorKeys = keys;

        return keys;
    }
    visitorEnterKeys (node) {
        if (typeof node !== 'object') return [typeof node];
        else if (node === null) return ['null'];
        else if (Array.isArray(node)) return ['array', 'enterArray'];
        return NODE_ENTER_KEYS[node.type] || [camelCase(node.constructor.name), enterTitleCase(node.constructor.name)];

        const cacheKey = typeof node === 'object' ? (node.type || node.constructor.name) : typeof node;
        const cached = this.cache.enter[cacheKey];
        if (cached) return cached;

        const keys = this.visitorKeys(node);
        const enterKeys = [];
        enterKeys.push('enter');
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            enterKeys.push(key);
            const enterKey = enterTitleCase(key);
            enterKeys.push(enterKey);
        }
        window.CACHE_SET_ENTER_KEYS = (window.CACHE_SET_ENTER_KEYS | 0) + 1;
        this.cache.enter[cacheKey] = enterKeys;
        return enterKeys;
    }
    visitorExitKeys (node) {
        if (typeof node !== 'object') return [];
        else if (node === null) return [];
        else if (Array.isArray(node)) return ['exitArray'];
        return NODE_EXIT_KEYS[node.type] || [exitTitleCase(node.constructor.name)];

        const cacheKey = typeof node === 'object' ? (node.type || node.constructor.name) : typeof node;
        const cached = this.cache.exit[cacheKey];
        if (cached) return cached;

        const keys = this.visitorKeys(node);
        const exitKeys = [];
        exitKeys.push('exit');
        for (let i = 0; i < keys.length; i++) {
            const exitKey = exitTitleCase(keys[i]);
            exitKeys.push(exitKey);
        }
        window.CACHE_SET_EXIT_KEYS = (window.CACHE_SET_EXIT_KEYS | 0) + 1;
        this.cache.exit[cacheKey] = exitKeys;
        return exitKeys;
    }
    pass () {
        const node = this.path.node;
        const nodeType = this.nodeType(node);
        const visitTypes = this.visitTypes[nodeType];
        if (typeof visitTypes === 'undefined') return;

        const nodeKeys = visitTypes.keys || node;
        if (nodeKeys.length > 0) this.queue(new QueuedKeys(this.path.pathArrayCopy, node, nodeKeys));
    }
    enter () {
        const node = this.path.node;
        const nodeType = this.nodeType(node);
        const visitTypes = this.visitTypes[nodeType];
        if (typeof visitTypes === 'undefined') return;

        const enterFunctions = visitTypes.enter;
        if (enterFunctions.length > 0) {
            this.visit(enterFunctions);
            // The node has been replaced and is no longer in the tree.
            if (node !== this.path.node) return this.queueChanges();
        }

        const exitFunctions = visitTypes.exit;
        if (exitFunctions.length > 0) this.queue(new QueuedExit(this.path.pathArrayCopy, node));

        if (enterFunctions.length > 0) this.queueChanges();

        const nodeKeys = visitTypes.keys || node;
        // if (nodeKeys.length > 0) this.queue(new QueuedKeys(this.path.pathArrayCopy, node, nodeKeys));
        if (nodeKeys.length > 0) this.queue(queuedKeysFromPath(this.path, node, nodeKeys));
    }
    exit () {
        const node = this.path.node;
        const exitFunctions = this.visitTypes[this.nodeType(node)].exit;
        this.visit(exitFunctions);
        this.queueChanges();
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
        node.uses = 0;
        state.vars[node.name] = node;
    }
    checkStatus (node, path, state) {
        const refNode = state.vars.thread;
        if (refNode) refNode.uses++;
    }
}
class JSFindArg {
    exitStoreArg (node, path, state) {
        state.paths[node.name] = state.paths[node.name] || {};
        state.paths[node.name][node.key] = path.pathArrayCopy;
    }
}
const findArg = new JSFindArg();
class JSInlineOperators {
    call (node, path, state) {
        const info = state.opMap[node.args];
        if (info && info.op.opcode === 'vm_may_continue') {
            const chunkParent = path.parents[path.length - 4];
            const chunkIndex = path.pathArray[path.length - 3];

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
                        ast.type.isBinaryOperator(statement.expr)
                    )
                ) return;
            }
            if (i < 0) {
                path.replaceWith(ast.cast(ast.p('thread', 'reuseStackForNextBlock'), ast.p(node.args, 'NEXT_STACK')));
                return;
            }
        }
        if (info && /^argument/.test(info.op.opcode)) {
            path.replaceWith(ast.cast2('definedOr', ast.cast2('getParam', 'thread', ast.p(node.args, 'VALUE')), 0));
        }
        if (info && /^operator_(add|subtract|multiply|divide)/.test(info.op.opcode)) {
            const store1Id = ast.property(node.args, 'NUM1');
            const store2Id = ast.property(node.args, 'NUM2');

            let operator = '+';
            if (info.op.opcode === 'operator_subtract') operator = '-';
            if (info.op.opcode === 'operator_multiply') operator = '*';
            if (info.op.opcode === 'operator_divide') operator = '/';

            path.replaceWith(ast.binaryOperator(operator, ast.cast('toNumber', store1Id), ast.cast('toNumber', store2Id)));
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

            path.replaceWith(ast.cast2('scratchMod', NUM1, NUM2));
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
                // floor10(Math.sin((Math.PI * NUM) / 180))
                return path.replaceWith(
                    ast.cast('floor10', ast.math(operator,
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
            path.replaceWith(ast.property(dataId, 'value'));
            if (!state.paths[dataId]) {
                state.paths[dataId] = path.parent.insertBefore(ast.storeVar(dataId, ast.p('target', `lookupOrCreateVariable('${id}', '${name}')`))).pathArrayCopy;
            }
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
            parentPath.replaceWith(ast.storeArg(dataId, 'value', ast.property(node.args, 'VALUE')));
            if (!state.paths[dataId]) {
                state.paths[dataId] = parentPath.insertBefore(ast.storeVar(dataId, ast.property('target', `lookupOrCreateVariable('${id}', '${name}')`))).pathArrayCopy;
            }
        }
        if (info && info.op.opcode === 'data_itemoflist') {
            const {id, name} = info.op._argValues.LIST;
            const dataId = `data_list_${safeId(name)}`;
            const indexId = `data_index_${node.args}_${safeId(name)}`;
            const {op2, ifElse, p, storeVar, cast2} = ast;
            let parentPath = path.parent;
            if (!state.paths[dataId]) {
                // var dataId = target.lookupOrCreateList('id', 'name')
                parentPath.insertBefore(storeVar(
                    dataId,
                    p('target', `lookupOrCreateList('${id}', '${name}')`)
                ));
                state.paths[dataId] = parentPath.pathArrayCopy;
            }
            // var indexId = toListIndex(args.INDEX, dataId.value.length)
            parentPath.insertBefore(storeVar(
                indexId,
                cast2('toListIndex', p(node.args, 'INDEX'), p(p(dataId, 'value'), 'length'))
            ));
            // indexId === LIST_INVALID ? '' dataId.value[indexId - 1]
            path.replaceWith(ifElse(
                op2('===', indexId, 'LIST_INVALID'),
                `''`,
                // dataId.value[indexId - 1]
                p(p(dataId, 'value'), op2('-', indexId, 1))
            ));
            debugger;
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
            ast.type.isBinaryOperator(node.value) && ['+', '-', '*', '/'].indexOf(node.value.operator)
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
                state.paths[node.expect] = new Path(path).goTo(['root', 'bindings']).appendChild(ast.storeVar(node.expect, ast.p('bindings', node.expect)));
            }
            if (node.expect === 'floor10') {
                state.paths.floor10 = new Path(path).goTo(['root', 'bindings']).appendChild(
                    ast.storeVar('floor10',
                        'function (value) {return value - (value % 1e-10);};'
                    ));
            }
            if (node.expect === 'scratchTan') {
                state.paths.scratchTan = new Path(path).goTo(['root', 'bindings']).appendChild(
                    ast.storeVar('scratchTan',
                        [
                            'function (value) {return (',
                            '(Math.abs(value + 180) % 180 === 90)',
                            'Math.sign((value + 360) % 360 - 180) * Infinity',
                            ast.cast('floor10', 'Math.sin((Math.PI * value) / 180)'),
                            ');};'
                        ]
                    ));
            }
        }
    }
    exitCast2 (node, path, state) {
        if (node.expect === 'getParam' && node.input1 === 'thread' && ast.type.isString(node.input2)) {
            return path.replaceWith(ast.p(ast.p('thread', 'stackFrame.params'), node.input2));
        }

        if (!state.paths[node.expect]) {
            if (Cast[node.expect]) {
                if (!state.bindings[node.expect]) state.bindings[node.expect] = Cast[node.expect];
                state.paths[node.expect] = new Path(path).goTo(['root', 'bindings']).appendChild(ast.storeVar(node.expect, ast.p('bindings', node.expect)));
            }
            if (node.expect === 'definedOr') {
                state.paths.definedOr =  new Path(path).goTo(['root', 'bindings']).appendChild(
                    ast.storeVar('definedOr',
                        [
                            'function (v, d) {return typeof v === \'undefined\' ? d : v;}'
                        ]
                    ));
            }
            if (node.expect === 'getParam') {
                state.paths.getParam =  new Path(path).goTo(['root', 'bindings']).appendChild(
                    ast.storeVar('getParam',
                        [
                            'function (t, k) {return t.stackFrame.params[k];}'
                        ]
                    ));
            }
            if (node.expect === 'scratchMod') {
                // (NUM1 % NUM2) + ((NUM1 < 0 !== NUM2 < 0) ? NUM2 : 0)
                state.paths.scratchTan = new Path(path).goTo(['root', 'bindings']).appendChild(
                    ast.storeVar('scratchMod',
                        [
                            'function (n, m) {return (n % m) + ((n < 0 !== m < 0) ? m : 0);}'
                        ]
                    ));
            }
        }
    }
    property (node, path, state) {
        if (typeof node.lhs === 'string' && typeof node.member === 'string') {
            if (!state.paths) {
                state.paths = {};
                const finder = new Transformer();
                finder.transform(path.parents[0], [findArg], [state]);
            }

            const info = state.opMap[node.lhs];
            const storePathArray = state.paths[node.lhs] && state.paths[node.lhs][node.member];

            if (!storePathArray) {
                if (info && !info.args[node.member]) {
                    if (typeof info.op._argValues[node.member] === 'number') {
                        path.replaceWith(info.op._argValues[node.member]);
                    } else if (typeof info.op._argValues[node.member] === 'string') {
                        path.replaceWith(`'${info.op._argValues[node.member]}'`);
                    }
                }
            } else if (info) {
                const storePath = new Path(path).goTo(storePathArray);
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
        path.replaceWith(ast.chunk([expr, code.t(';')]));
    }
    storeArg ({name, key, expr}, path, state) {
        const {t} = code;
        path.replaceWith(ast.chunk([name, '.', key, t(' = '), expr, t(';')]));
    }
    storeVar ({uses, name, expr}, path, state) {
        const {t} = code;
        if (uses === 0 && state.minimize) return path.skip();
        if (uses === 0) return path.replaceWith(ast.chunk([t('/* skipping unused var '), name, t('. */')]));
        path.replaceWith(ast.chunk([t('var '), name, t(' = '), expr, t(';'), state.minimize ? '' : t(` /* uses: ${uses} */`)]));
    }
    cast ({expect, value}, path, state) {
        const {t} = code;
        path.replaceWith(ast.chunk([expect, t('('), value, t(')')]));
    }
    cast2 ({expect, input1, input2}, path, state) {
        const {t} = code;
        path.replaceWith(ast.chunk([expect, t('('), input1, ', ', input2, t(')')]));
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
        path.replaceWith(ast.chunk([t('('), input1, t(' '), operator, t(' '), input2, t(')')]));
    }
    callBlock ({context, func, args}, path, state) {
        path.replaceWith(ast.chunk([func, '.call(', context, ', ', args, ', ', 'blockUtility', ')']))
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

    const perf = {
        start: performance.now(),
        end: 0,
        baseline: 0,
        inline: 0,
        count: 0,
        optimized: 0,
        minimized: 0
    };
    let last = perf.start;
    perf.baseline = -last;
    const baselineState = {
        source: '',
        minimize: false
    };
    new Transformer().transform(ast.cloneDeep(factoryAST), [new JSPrinter()], [baselineState]);
    const baseline = baselineState.source;
    perf.baseline += (last = performance.now());

    perf.inline = -last;
    const inlineState = {bindings, opInfos, opMap, paths: {}};
    new Transformer().transform(factoryAST, [new JSFindArg(), new JSInlineOperators()], [inlineState, inlineState]);
    perf.inline += (last = performance.now());

    perf.count = -last;
    const countRefs = {vars: {
        bindings: {uses: 0},
        blockUtility: {uses: 0}
    }, strings: []};
    new Transformer().transform(factoryAST, [new JSCountRefs()], [countRefs]);
    perf.count += (last = performance.now());

    // console.log(countRefs.strings, ast.cloneDeep(factoryAST));
    // console.log(ast.cloneDeep(factoryAST));
    let mangled = Object.entries(countRefs.vars);
    mangled = mangled.sort(([,{uses}], [,{uses: uses2}]) => uses2 - uses);
    // console.log(mangled);
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

    perf.optimized = -last;
    new Transformer().transform(ast.cloneDeep(factoryAST), [new JSPrinter()], [renderState]);
    const optimized = renderState.source;
    perf.optimized += (last = performance.now());

    perf.minimized = -last;
    renderState.source = '';
    renderState.minimize = true;
    new Transformer().transform(ast.cloneDeep(factoryAST), [new JSMangle(), new JSPrinter()], [renderState, renderState]);
    const minimized = renderState.source;
    perf.minimized += (perf.end = last = performance.now());

    (window.AST_COMPILE = (window.AST_COMPILE || [])).push([inlineState, countRefs, renderState, factoryClone, factoryAST]);
    // console.log(Date.now() - start);

    const factory = new Function(mangled['bindings'] || 'bindings', renderState.source);

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

        // lastBlock = executeOps(thread, blockCached._allOps);
        const ops = blockCached._allOps;
        // if (isProfiling && ops[0].opcode !== 'vm_compiled') window.NORMAL_USE = (window.NORMAL_USE | 0) + 1;
        let i = -1;
        while (thread.status === STATUS_RUNNING) {
            const opCached = ops[++i];
            opCached._parentValues[opCached._parentKey] = (
                opCached._blockFunction(opCached._argValues, blockUtility));
            // if (isPromise(opCached._parentValues[opCached._parentKey] = (
            //     opCached._blockFunctionUnbound.call(
            //         opCached._blockFunctionContext,
            //         opCached._argValues, blockUtility
            // )))) {
            //     blockCached.count = 0;
            //     thread.status = Thread.STATUS_PROMISE_WAIT;
            // }
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
