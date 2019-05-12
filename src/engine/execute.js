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

        /**
         * The inputs key the parent refers to this BlockCached by.
         * @type {string}
         */
        this._parentKey = 'VALUE';

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

class InputBlockCached extends BlockCached {
    constructor (blockContainer, cached) {
        super(blockContainer, cached);

        const {runtime} = blockUtility.sequencer;

        const {opcode, fields, inputs} = this;

        // Assign opcode isHat and blockFunction data to avoid dynamic lookups.
        this._isHat = runtime.getIsHat(opcode);
        this._blockFunction = runtime.getOpcodeFunction(opcode);
        this._definedBlockFunction = typeof this._blockFunction === 'function';
        if (this._definedBlockFunction) {
            // If available, save the unbound function. It's faster to
            // unbound.call(context) than to call unbound.bind(context)().
            this._blockFunctionUnbound = this._blockFunction._function || this._blockFunction;
            this._blockFunctionContext = this._blockFunction._context;
        } else {
            this._blockFunctionUnbound = null;
            this._blockFunctionContext = null;
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

                this._shadowOps.push(...inputCached._shadowOps);
                this._ops.push(...inputCached._ops);
                inputCached._parentKey = 'name';
                inputCached._parentValues = this._argValues.BROADCAST_OPTION;
            } else if (input.block) {
                const inputCached = BlocksExecuteCache.getCached(blockContainer, input.block, InputBlockCached);

                if (inputCached._isHat) {
                    continue;
                }

                this._shadowOps.push(...inputCached._shadowOps);
                this._ops.splice(this._ops.length - 1, 0, ...inputCached._ops.slice(0, inputCached._ops.length - 1));
                if (inputCached._ops.length > 0) this._ops.push(inputCached._ops[inputCached._ops.length - 1]);
                inputCached._parentKey = inputName;
                inputCached._parentValues = this._argValues;

                // Shadow values are static and do not change, go ahead and
                // store their value on args.
                if (inputCached._isShadowBlock) {
                    this._argValues[inputName] = inputCached._shadowValue;
                }
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

const safeId = function (id) {
    id = String(id);
    return id[0].replace(/[^a-zA-Z]/g, '_') + id.substring(1).replace(/[^_\w]/g, '_');
}

const findId = function (_set, obj, _default, prefix) {
    if (!obj) return safeId('null');
    let index = Object.values(_set).indexOf(obj);
    if (index > -1) {
        return safeId(Object.keys(_set)[index]);
    } else if (!_default || _set[_default]) {
        _set.__nextId = (_set.__nextId || 0) + 1;
        return safeId(`${prefix || ''}${_set.__nextId}`);
    }
    return safeId(_default);
};

class JSNode {
    constructor ({refs = []} = {}) {
        this.refs = refs.filter(ast.type.isString);
    }
    get type () {
        return this.constructor.name[2].toLowerCase() + this.constructor.name.substring(3);
    }
    toString () {
        return '';
    }
}
class JSWhitespace {}
class JSId extends JSNode {
    constructor ({id, refs = [id]}) {
        super({refs});
        this.id = id;
    }
}
class JSChunk extends JSNode {
    constructor ({refs, statements}) {
        super({refs});
        this.statements = statements;
    }
    toString () {
        return this.statements.join('');
    }
}
class JSStatement extends JSNode {
    constructor ({indent = new JSWhitespace(), expr, refs = [expr]} = {}) {
        super({refs});
        this.indent = indent;
        this.expr = expr;
    }
}
class JSExpressionStatement extends JSStatement {
    constructor ({expr, refs = [expr]}) {
        super({refs, expr});
    }
    toString () {
        return `${this.expr};`;
    }
}
class JSCheckStatus extends JSStatement {
    constructor () {
        super({refs: ['thread']});
    }
    toString () {
        return 'if (thread.status !== 0) return;';
    }
}
class JSStore extends JSStatement {
    constructor ({expr, refs = [expr]}) {
        super({refs, expr});
    }
}
class JSStoreArg extends JSStore {
    constructor ({expr, name, key, refs = [expr, name]}) {
        super({refs, expr});
        this.name = name;
        this.key = key;
    }
    toString () {
        return `${this.name}.${this.key} = ${this.expr};`;
    }
}
class JSStoreVar extends JSStore {
    constructor ({uses = 0, expr, name, refs = [expr]}) {
        super({refs, expr});
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
    constructor ({expect, value, refs = [expect, value]}) {
        super({refs});
        this.expect = expect;
        this.value = value;
    }
}
class JSProperty extends JSOperator {
    constructor ({lhs, member, refs = [lhs]}) {
        super({refs});
        this.lhs = lhs;
        this.member = member;
    }
    toString () {
        return `${this.lhs}.${this.member}`;
    }
}
class JSGetVariable extends JSOperator {}
class JSBinaryOperator extends JSOperator {
    constructor ({operator, input1, input2, refs = [input1, input2]}) {
        super({refs});
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
    constructor ({context, func, args, refs = [context, func, args]}) {
        super({refs});
        this.context = context;
        this.func = func;
        this.args = args;
    }
    toString () {
        return `${this.func}.call(${this.context}, ${this.args}, blockUtility)`;
    }
}
class JSCallFunction extends JSCall {
    constructor ({func, args, refs = [func, args]}) {
        super({refs});
        this.func = func;
        this.args = args;
    }
    toString () {
        return `${this.func}(${this.args}, blockUtility)`;
    }
}
class JSFactory extends JSNode {
    constructor ({debugName, bindings = [], dereferences = [], chunks = [], refs}) {
        super({refs});
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
        return new JSExpressionStatement({expr});
    },
    checkStatus () {
        return new JSCheckStatus();
    },
    storeArg (name, key, expr) {
        return new JSStoreArg({name, key, expr});
    },
    storeVar (name, expr) {
        return new JSStoreVar({name, expr});
    },
    cast (expect, value) {
        return new JSCast({expect, value});
    },
    property (lhs, member) {
        return new JSProperty({lhs, member});
    },
    binaryOperator (operator, input1, input2) {
        return new JSBinaryOperator({operator, input1, input2});
    },
    callBlock (context, func, args) {
        return new JSCallBlock({context, func, args});
    },
    callFunction (func, args) {
        return new JSCallFunction({func, args});
    },
    factory (debugName) {
        return new JSFactory({debugName});
    },
    type: {
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
            return node instanceof JSId;
        },
        isChunk (node) {
            return node instanceof JSChunk;
        },
        isStatement (node) {
            return node instanceof JSStatement;
        },
        isExpressionStatement (node) {
            return node instanceof JSExpressionStatement;
        },
        isCheckStatus (node) {
            return node instanceof JSCheckStatus;
        },
        isStore (node) {
            return node instanceof JSStore;
        },
        isStoreArg (node) {
            return node instanceof JSStoreArg;
        },
        isStoreVar (node) {
            return node instanceof JSStoreVar;
        },
        isOperator (node) {
            return node instanceof JSOperator;
        },
        isCast (node) {
            return node instanceof JSCast;
        },
        isProperty (node) {
            return node instanceof JSProperty;
        },
        isBinaryOperator (node) {
            return node instanceof JSBinaryOperator;
        },
        isCall (node) {
            return node instanceof JSCall;
        },
        isCallBlock (node) {
            return node instanceof JSCallBlock;
        },
        isCallFunction (node) {
            return node instanceof JSCallFunction;
        },
        isFactory (node) {
            return node instanceof JSFactory;
        }
    }
};
class JSToken extends JSNode {
    constructor ({token}) {
        super();
        this.token = token;
    }
}
const code = {
    t (token) {
        return code.token(token);
    },
    token (token) {
        return new JSToken({token});
    }
};

class Path {
    constructor (parentPath) {
        const {pathArray, parents} = parentPath;
        this.parentPath = this;
        this.pathArray = pathArray;
        this.parents = parents;
        this.node = parents[parents.length - 1];
        this.changedNodes = [];
        if (parentPath instanceof Path) {
            this.parentPath = parentPath.parentPath;
            this.parents = parents.slice();
            this.changedNodes = parentPath.changedNodes;
        }
    }
    get length () {
        return this.pathArray.length;
    }
    get key () {
        return this.pathArray[this.length - 1];
    }
    get parent () {
        const newPathArray = this.pathArray.slice(0, this.length - 1);
        return new Path(this).setPath(newPathArray);
    }
    get parentKey () {
        return this.pathArray[this.length - 2];
    }
    get parentNode () {
        return this.parents[this.length - 2];
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
    setPath (pathArray) {
        const parents = this.parents;
        let i = 1;
        let node = parents[0];
        for (; node && i < pathArray.length; i++) {
            node = parents[i - 1][pathArray[i]];
            if (node) parents[i] = node;
            else i = 1;
        }
        this.pathArray = pathArray;
        this.pathArray.length = i;
        this.parents.length = i;
        this.node = this.parents[i - 1];
        return this;
    }
    skip () {
        this.node = null;
    }
    stop () {
        this.pathArray.length = 0;
    }
    setKey (key, newNode) {
        const parentDepth = this.parents.length - 1;
        return this._insert(parentDepth, key, newNode);
    }
    getKey (key) {
        return new Path(this).setPath([...this.pathArray, key]);
    }
    earlierPath (laterPath) {
        let i = 1;
        const length = Math.min(this.pathArray.length, laterPath.pathArray.length);
        for (; i < length && this.pathArray[i] === laterPath.pathArray[i]; i++) {}
        if (i < length) {
            const key = this.pathArray[i];
            const laterKey = laterPath.pathArray[i];
            if (typeof key === 'number') {
                return key < laterKey;
            } else {
                const parent = this.parents[i - 1];
                const siblings = Object.keys(parent);
                return siblings.indexOf(key) < siblings.indexOf(laterKey);
            }
        }
        return this.pathArray.length < laterPath.pathArray.length;
    }
    confirmPath () {
        for (let i = this.pathArray.length - 1; i > 0; i--) {
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
        const parent = this.parents[this.parents.length - 2];
        if (!Array.isArray(parent)) throw new Error('Must use insertBefore with a parent array');
    }
    remove () {
        this.confirmPath();
        const parent = this.parents[this.parents.length - 2];
        const parentKey = this.pathArray[this.pathArray.length - 1];
        if (Array.isArray(parent)) parent.splice(Number(parentKey), 1);
        else parent[parentKey] = null;
        this.node = null;
    }
    replaceWith (newNode) {
        if (this.length === 1) {
            this.parents[0] = newNode;
            this.node = newNode;
            this.changedNodes.push({pathArray: this.pathArray.slice(), node: newNode});
            return new Path(this);
        }
        this.confirmPath();
        const parent = this.parents[this.parents.length - 2];
        const parentKey = this.pathArray[this.pathArray.length - 1];
        parent[parentKey] = newNode;
        this.changedNodes.push({pathArray: this.pathArray.slice(), node: newNode});
        return new Path(this);
    }
    _insert (depth, index, newNode) {
        this.confirmPath();
        const parent = this.parents[depth];
        if (Array.isArray(parent)) parent.splice(Number(index), 0, newNode);
        else parent[index] = newNode;
        const newPathArray = this.pathArray.slice();
        if (depth <= newPathArray.length) {
            newPathArray.length = depth;
            newPathArray[depth] = index;
        }
        const newPath = new Path(this).setPath(newPathArray);
        if (newPath.earlierPath(this)) this.changedNodes.push({pathArray: newPathArray, node: newNode});
        return newPath;
    }
    insertSibling (index, newNode) {
        this.confirmArrayParent();
        const parentDepth = this.parents.length - 2;
        return this._insert(parentDepth, index, newNode);
    }
    insertFirst (newNode) {
        return this.insertSibling(0, newNode);
    }
    insertLast (newNode) {
        const parent = this.parents[this.parents.length - 2];
        return this.insertSibling(parent.length, newNode);
    }
    insertBefore (newNode) {
        const parentKey = this.pathArray[this.pathArray.length - 1];
        return this.insertSibling(parentKey, newNode);
    }
    insertAfter (newNode) {
        const parentKey = this.pathArray[this.pathArray.length - 1];
        return this.insertSibling(parentKey + 1, newNode);
    }
    insertChild (index, newNode) {
        this.confirmArrayParent();
        const parentDepth = this.parents.length - 1;
        return this._insert(parentDepth, index, newNode);
    }
    prependChild () {
        return this.insertChild(0, newNode);
    }
    appendChild () {
        const node = this.node;
        return this.insertChild(node.length, newNode);
    }
}
class Visitor {
    factory () {}
    enterFactory () {}
    exitFactory () {}
}
class Transformer {
    constructor () {
        this.path = null;
        this.visitors = null;
        this.states = null;
        this.i = 0;
        this.queued = null;
    }
    transform (root, visitors, states) {
        this.i = 0;
        this.queued = []
        this.path = Path.fromRoot(root);
        this.visitors = visitors || [];
        this.states = states || [];
        this.queue('enter', [{pathArray: this.path.pathArray, node: root}]);
        while (this.i < this.queued.length) {
            const item = this.queued[this.i];
            this.path.setPath(item.pathArray);
            if (this.i > 100000 || this.path.length > 100) return;
            if (this.path.node === item.node) {
                if (item.mode === 'enter') {
                    this.enter();
                } else {
                    this.exit();
                }
                if (this.path.length === 0) break;
                this.queue('enter', this.path.changedNodes);
                this.path.changedNodes.length = 0;
            }
            this.i += 1;
        }
    }
    queue (mode, newNodes) {
        this.queued.splice(this.i + 1, 0, ...newNodes.map(info => ({mode, ...info})));
    }
    visit (keys) {
        const node = this.path.node;
        for (let i = 0; node === this.path.node && i < this.visitors.length; i++) {
            const visitor = this.visitors[i];
            for (let j = 0; j < keys.length; j++) {
                if (visitor[keys[j]]) {
                    visitor[keys[j]](node, this.path, this.states[i]);
                }
            }
        }
    }
    nodeKeys (node) {
        let keys;
        if (Array.isArray(node)) keys = Array.from(node, (_, i) => i);
        else if (typeof node === 'object' && node) keys = Object.keys(node);
        else keys = [];
        return keys.map(key => ({
            pathArray: [...this.path.pathArray, key],
            node: node[key]
        }));
    }
    visitorKeys (node) {
        const keys = new Set();
        if (Array.isArray(node)) {
            keys.add('array');
        } else if (typeof node === 'object') {
            while (node && node.type) {
                keys.add(node.type);
                node = Object.getPrototypeOf(node);
            }
        } else {
            keys.add(typeof node);
        }
        return Array.from(keys);
    }
    visitorEnterKeys (node) {
        return ['enter', ...this.visitorKeys(node).map(type => `enter${type.toUpperCase() + type.substring(1)}`)];
    }
    visitorExitKeys (node) {
        return ['exit', ...this.visitorKeys(node).map(type => `exit${type.toUpperCase() + type.substring(1)}`)];
    }
    enter () {
        const node = this.path.node;
        this.visit([...this.visitorKeys(node), ...this.visitorEnterKeys(node)]);
        if (node === this.path.node) this.queue('exit', [{node, pathArray: this.path.pathArray}]);
        if (node === this.path.node) this.queue('enter', this.nodeKeys(node));
    }
    exit () {
        const node = this.path.node;
        this.visit(this.visitorExitKeys(node));
    }
}
class JSCountRefs {
    node (node, path, state) {
        const {refs} = node;
        if (ast.type.isId(node) && refs.length === 0) debugger;
        for (let i = 0; i < refs.length; i++) {
            const refNode = state.vars[refs[i]];
            if (refNode) refNode.uses++;
        }
    }
    storeVar (node, path, state) {
        node.uses = 0;
        state.vars[node.name] = node;
    }
}
class JSFindArg {
    storeArg (node, path, state) {
        state.paths[node.name] = state.paths[node.name] || {};
        state.paths[node.name][node.key] = path.pathArray;
    }
}
const findArg = new JSFindArg();
class JSInlineOperators {
    call (node, path, state) {
        const info = state.opInfos.find(info => info.id === node.args);
        if (info && /^operator_(add|subtract|multiply|divide)/.test(info.op.opcode)) {
            const store1Id = ast.property(node.args, 'NUM1');
            const store2Id = ast.property(node.args, 'NUM2');

            let operator = '+';
            if (info.op.opcode === 'operator_subtract') operator = '-';
            if (info.op.opcode === 'operator_multiply') operator = '*';
            if (info.op.opcode === 'operator_divide') operator = '/';

            path.replaceWith(ast.binaryOperator(operator, ast.cast('toNumber', store1Id), ast.cast('toNumber', store2Id)));
        }
    }
    property (node, path, state) {
        if (typeof node.lhs === 'string' && typeof node.member === 'string') {
            if (!state.paths) {
                state.paths = {};
                const finder = new Transformer();
                finder.transform(path.parents[0], [findArg], [state]);
            }

            const storePathArray = state.paths[node.lhs] && state.paths[node.lhs][node.member];

            if (!storePathArray) {
                // const info = state.opInfos.find(info => info.parentId === node.lhs && info.op._parentKey === node.member);
                // if (info) path.replaceWith(Cast.toNumber(info.op._argValues[node.member]));
            } else {
                const storePath = new Path(path).setPath(storePathArray);
                const storeExpr = storePath.node.expr;

                if (storeExpr instanceof JSCall || storeExpr instanceof JSProperty || storeExpr instanceof JSBinaryOperator) {
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
    array (node, path, state) {
        if (path.key === 'refs') path.skip();
    }
    checkStatus (node, path, state) {
        state.source += 'if (thread.status !== 0) return;';
    }
    expressionStatement ({expr}, path, state) {
        path.replaceWith(ast.chunk([expr, code.t(';')]));
    }
    storeArg ({name, key, expr}, path, state) {
        const {t} = code;
        path.replaceWith(ast.chunk([name, t('.'), key, t(' = '), expr, t(';')]));
    }
    storeVar ({uses, name, expr}, path, state) {
        const {t} = code;
        if (uses === 0) return path.replaceWith(ast.chunk([t('/* skipping unused var '), name, t('. */')]));
        path.replaceWith(ast.chunk([t('var '), name, t(' = '), expr, t(';'), t(` /* uses: ${uses} */`)]));
    }
    cast (node, path, state) {
        const {t} = code;
        path.replaceWith(ast.chunk([node.expect, t('('), node.value, t(')')]));
    }
    property (node, path, state) {
        const {t} = code;
        path.replaceWith(ast.chunk([node.lhs, t('.'), node.member]));
    }
    binaryOperator ({operator, input1, input2}, path, state) {
        const {t} = code;
        path.replaceWith(ast.chunk([t('('), input1, t(' '), operator, t(' '), input2, t(')')]));
    }
    callBlock ({context, func, args}, path, state) {
        const {t} = code;
        path.replaceWith(ast.chunk([func, t('.call('), context, t(', '), args, t(', blockUtility)')]))
    }
    callFunction ({func, args}, path, state) {
        const {t} = code;
        path.replaceWith(ast.chunk([func, t('('), args, t(', blockUtility)')]));
    }
    factory ({bindings, dereferences, debugName, chunks}, path, state) {
        const {t} = code;
        path.replaceWith(ast.chunk([
            bindings,
            t('return function '), debugName, t(' (_, blockUtility) {'),
            dereferences,
            chunks,
            t('};')
        ]));
    }
}

const compile = function (blockCached) {
    const ops = blockCached._allOps;

    // const bindings = {contexts: {}, functions: {}, args: {}, out: {}};
    // const contexts = [];
    // let source = '';
    // let commandParent = 0;

    const bindings = {};
    const factoryAST = new JSFactory({
        debugName: `${blockCached.opcode}_${ops.length}`
    });

    factoryAST.dereferences.push(
        ast.storeVar('thread', ast.property('blockUtility', 'thread'))
    );

    // const findVar = function (name) {
    //     return (
    //         [].concat.apply([], factoryAST.chunks.map(chunk => chunk.statements.filter(store => store instanceof JSStoreVar))).find(store => store.name === name) ||
    //         factoryAST.dereferences.find(store => store.name === name) ||
    //         factoryAST.bindings.find(store => store.name === name)
    //     );
    // }
    //
    // const addRef = function (name) {
    //     const node = findVar(name);
    //     if (node) node.uses++;
    // };
    //
    // const removeRef = function (name) {
    //     const node = findVar(name);
    //     if (node) node.uses--;
    // };

    const bind = function (i, name, value) {
        if (value && !bindings[name]) {
            bindings[name] = value;
            factoryAST.bindings.push(ast.storeVar(name, ast.property('bindings', name)));
        }
    };

    bind(-1, 'toNumber', Cast.toNumber);
    bind(-1, 'commandArg', {mutation: null, VALUE: null});

    const opInfos = [];

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const argValues = op._argValues;
        const func = op._blockFunctionUnbound;
        const context = op._blockFunctionContext;

        const id = findId(bindings, argValues, `arg_${i}`, 'arg_');
        const contextId = findId(bindings, context, context && context.constructor.name, 'ctx_');
        const functionId = findId(bindings, func, op.opcode, 'fn_');

        opInfos[i] = {op, id, parentId: null, contextId, functionId};

        bind(i, contextId, context);
        bind(i, functionId, func);
        bind(i, id, argValues);
    }

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const parentValues = op._parentValues;

        const parentI = ops.findIndex(({_argValues}) => _argValues === parentValues);
        opInfos[i].parentId = parentI > -1 ? findId(bindings, parentValues) : 'commandArg';

        const {id, parentId, contextId, functionId} = opInfos[i];
        factoryAST.chunks.push([
            ast.storeArg(parentId, op._parentKey, ast.callBlock(contextId, functionId, id)),
            ast.checkStatus()
        ]);
    }

    let start = Date.now();
    const inlineState = {opInfos, paths: null};
    new Transformer().transform(factoryAST, [new JSInlineOperators()], [inlineState]);
    const countRefs = {vars: {}};
    new Transformer().transform(factoryAST, [new JSCountRefs()], [countRefs]);
    const factoryClone = ast.cloneDeep(factoryAST);
    const renderState = {source: ''};
    new Transformer().transform(factoryClone, [new JSPrinter()], [renderState]);
    (window.AST_COMPILE = (window.AST_COMPILE || [])).push([factoryAST, renderState]);
    console.log(Date.now() - start);

    // for (let i = 0; i < factoryAST.chunks.length; i++) {
    //     const op = ops[i];
    //     const chunk = factoryAST.chunks[i];
    //
    //     const context = op._blockFunctionContext;
    //     const func = op._blockFunctionUnbound;
    //     const funcsrc = func.toString();
    //
    //     const statement = chunk.statements[0];
    //     let call;
    //     if (statement instanceof JSStatement) {
    //         call = statement.expr;
    //     }
    //
    //     if (!/this/.test(funcsrc)) {
    //         statement.expr = new JSCallFunction({
    //             func: call.func,
    //             args: call.args
    //         });
    //         removeRef(call.context);
    //     } else if (context) {
    //         const methodId = [
    //             ...Object.getOwnPropertyNames(context),
    //             ...Object.getOwnPropertyNames(Object.getPrototypeOf(context))
    //         ].find(key => context[key] === func);
    //         if (methodId && safeId(methodId) === methodId) {
    //             statement.expr = new JSCallFunction({
    //                 func: new JSProperty({
    //                     lhs: call.context,
    //                     member: methodId
    //                 }),
    //                 args: call.args
    //             });
    //             removeRef(call.func);
    //         }
    //     }
    //
    //     if (
    //         // this opcode does not modify the thread status
    //         /^(operator|data|argument)/.test(op.opcode) ||
    //         // no need to check the last operation the function is done
    //         i === ops.length - 1
    //     ) {
    //         const before = chunk.statements.length;
    //         chunk.statements = chunk.statements
    //             .filter(stmt => !(stmt instanceof JSCheckStatus));
    //         const after = chunk.statements.length;
    //         for (let j = 0; j < (before - after); j++) removeRef('thread');
    //     }
    //
    //     if (
    //         op.opcode === 'vm_may_continue' &&
    //         (
    //             // is the first operation
    //             i === 0 ||
    //             // or last opcode does not modify the stack
    //             /^(operator|data|argument)/.test(ops[i - 1].opcode)
    //         )
    //     ) {
    //         const call = chunk.statements[0].expr;
    //         call.context && removeRef(call.context);
    //         call.func && removeRef(call.func);
    //         removeRef(call.args);
    //         if (chunk.statements.length === 1) addRef('thread');
    //
    //         if (i === ops.findIndex(({opcode}) => opcode === 'vm_may_continue') && i < ops.length - 1) {
    //             // the first vm_may_continue operation
    //             chunk.statements = [
    //                 new JSExpressionStatement({
    //                     expr: `if (thread.continuous) thread.reuseStackForNextBlock('${op._argValues.NEXT_STACK}')`
    //                 }),
    //                 new JSExpressionStatement({
    //                     expr: `else return thread.status = ${Thread.STATUS_INTERRUPT}`
    //                 })
    //             ];
    //             if (i === ops.length - 1) {
    //                 // also the last
    //                 chunk.statements[1] = new JSExpressionStatement({
    //                     expr: `thread.status = ${Thread.STATUS_INTERRUPT}`
    //                 });
    //             }
    //         } else if (i < ops.length - 1) {
    //             // not the first or last operation
    //             chunk.statements = [
    //                 new JSExpressionStatement({
    //                     expr: `thread.reuseStackForNextBlock('${op._argValues.NEXT_STACK}')`
    //                 })
    //             ];
    //         } else {
    //             // not the first but the last operation
    //             chunk.statements = [
    //                 new JSExpressionStatement({
    //                     expr: `thread.reuseStackForNextBlock(null)`
    //                 }),
    //                 new JSExpressionStatement({
    //                     expr: `thread.status = ${Thread.STATUS_INTERRUPT}`
    //                 })
    //             ];
    //             if (i === ops.findIndex(({opcode}) => opcode === 'vm_may_continue')) {
    //                 chunk.statements[0] = new JSExpressionStatement({
    //                     expr: `if (thread.continuous) thread.reuseStackForNextBlock(null)`
    //                 });
    //             }
    //         }
    //     }
    //
    //     if (op.opcode === 'data_variable' || op.opcode === 'data_setvariableto') {
    //         const argValues = op._argValues;
    //         const localId = `local_${safeId(argValues.VARIABLE.name)}`;
    //         if (!findVar(localId)) {
    //             chunk.statements.unshift(new JSStoreVar({
    //                 name: localId,
    //                 expr: `target.lookupOrCreateVariable('${argValues.VARIABLE.id}', '${argValues.VARIABLE.name}')`
    //             }));
    //             if (!findVar('target')) {
    //                 chunk.statements.unshift(new JSStoreVar({
    //                     name: 'target',
    //                     expr: 'blockUtility.target'
    //                 }));
    //             }
    //             addRef('target');
    //         }
    //         if (op.opcode === 'data_variable') {
    //             const callIndex = chunk.statements.findIndex(st => st instanceof JSStoreArg);
    //             const call = chunk.statements[callIndex].expr;
    //             call.context && removeRef(call.context);
    //             call.func && removeRef(call.func);
    //             removeRef(call.args);
    //             chunk.statements[callIndex].expr = new JSProperty({
    //                 lhs: localId,
    //                 member: 'value'
    //             });
    //         } else {
    //             const callIndex = chunk.statements.findIndex(st => st instanceof JSExpressionStatement);
    //             const call = chunk.statements[callIndex].expr;
    //             call.context && removeRef(call.context);
    //             call.func && removeRef(call.func);
    //             chunk.statements.splice(callIndex, 1,
    //                 new JSStoreArg({
    //                     name: localId,
    //                     key: 'value',
    //                     expr: `${call.args}.VALUE`
    //                 }),
    //                 new JSExpressionStatement({
    //                     expr: `if (${localId}.isCloud) blockUtility.ioQuery('cloud', 'requestUpdateVariable', [${localId}.name, ${call.args}.VALUE])`
    //                 })
    //             );
    //         }
    //         addRef(localId);
    //     }
    //
    //     if (/^operator_(add|subtract|multiply|divide)/.test(op.opcode)) {
    //         const argValues = op._argValues;
    //         const store1Index = ops.findIndex(({_parentValues, _parentKey}) => _parentValues === argValues && _parentKey === 'NUM1');
    //         const store2Index = ops.findIndex(({_parentValues, _parentKey}) => _parentValues === argValues && _parentKey === 'NUM2');
    //
    //         const id = findId(bindings, argValues);
    //         // let store1Id = `${id}.NUM1`;
    //         let store1Id = `${Cast.toNumber(argValues.NUM1)}`;
    //         if (store1Index > -1) {
    //             const chunk1 = factoryAST.chunks[store1Index];
    //             const stmtIndex = chunk1.statements.findIndex(st => st instanceof JSStoreArg);
    //             const stmt1 = chunk1.statements[stmtIndex];
    //             if (stmt1) {
    //                 if (stmt1.expr instanceof JSCall || stmt1.expr instanceof JSProperty) {
    //                     chunk1.statements = chunk1.statements.slice(0, stmtIndex);
    //                     store1Id = stmt1.expr;
    //                 } else if (stmt1.expr instanceof JSBinaryOperator) {
    //                     chunk1.statements = chunk1.statements.slice(0, stmtIndex);
    //                     store1Id = `(${stmt1.expr})`;
    //                 } else {
    //                     store1Id = `var_${store1Index}`;
    //                     chunk1.statements[stmtIndex] = new JSStoreVar({
    //                         name: store1Id,
    //                         expr: stmt1.expr
    //                     });
    //                     chunk1.statements[stmtIndex].uses = 1;
    //                 }
    //                 if (!/^operator_(add|subtract|multiply|divide|random|length|mod|round|mathop)$/.test(ops[store1Index].opcode)) {
    //                     store1Id = `toNumber(${store1Id})`;
    //                 }
    //             }
    //         }
    //         // let store2Id = `${id}.NUM2`;
    //         let store2Id = `${Cast.toNumber(argValues.NUM2)}`;
    //         if (store2Index > -1) {
    //             const chunk2 = factoryAST.chunks[store2Index];
    //             const stmtIndex = chunk2.statements.findIndex(st => st instanceof JSStoreArg);
    //             const stmt2 = chunk2.statements[stmtIndex];
    //             if (stmt2) {
    //                 if (stmt2.expr instanceof JSCall || stmt2.expr instanceof JSProperty) {
    //                     chunk2.statements = chunk2.statements.slice(0, stmtIndex);
    //                     store2Id = stmt2.expr;
    //                 } else if (stmt2.expr instanceof JSBinaryOperator) {
    //                     chunk2.statements = chunk2.statements.slice(0, stmtIndex);
    //                     store2Id = `(${stmt2.expr})`;
    //                 } else {
    //                     store2Id = `var_${store2Index}`;
    //                     chunk2.statements[stmtIndex] = new JSStoreVar({
    //                         name: store2Id,
    //                         expr: stmt2.expr
    //                     });
    //                     chunk2.statements[stmtIndex].uses = 1;
    //                 }
    //                 if (!/^operator_(add|subtract|multiply|divide|random|length|mod|round|mathop)$/.test(ops[store2Index].opcode)) {
    //                     store2Id = `toNumber(${store2Id})`;
    //                 }
    //             }
    //         }
    //
    //         let operator = '+';
    //         if (op.opcode === 'operator_subtract') operator = '-';
    //         if (op.opcode === 'operator_multiply') operator = '*';
    //         if (op.opcode === 'operator_divide') operator = '/';
    //
    //         const expr = chunk.statements[0].expr;
    //         if (store1Index > -1 && store2Index > -1) {
    //             removeRef(expr.args);
    //         }
    //         if (store1Index > -1 || store2Index > -1) {
    //             bind(i, 'toNumber', Cast.toNumber);
    //             addRef('toNumber');
    //         }
    //
    //         chunk.statements[0].expr = new JSBinaryOperator({
    //             operator,
    //             input1: store1Id,
    //             input2: store2Id
    //         });
    //     }
    // }

    // const renderState = {source: ''};
    // new Transformer().transform(factoryClone, [new JSPrinter()], [renderState]);

    const factory = new Function('bindings', renderState.source);

    const compileCached = new BlockCached(null, {
        id: blockCached.id,
        opcode: 'vm_compiled',
        fields: {},
        inputs: {},
        mutation: null
    });
    compileCached._blockFunctionUnbound = factory(bindings);
    (window.COMPILED = (window.COMPILED || {}))[compileCached._blockFunctionUnbound.name] = factory.toString();
    // return;
    // console.log(factory.toString());
    // window.LONGEST_COMILE = Math.max(window.LONGEST_COMILE | 0, blockCached._allOps.length);
    // window.COMILES = (window.COMILES | 0) + 1;
    // console.log(bindings, compileCached._blockFunctionUnbound);
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
            if (isPromise(opCached._parentValues[opCached._parentKey] = (
                opCached._blockFunctionUnbound.call(
                    opCached._blockFunctionContext,
                    opCached._argValues, blockUtility
            )))) {
                blockCached.count = 0;
                thread.status = Thread.STATUS_PROMISE_WAIT;
            }
        }
        lastBlock = ops[i];

        if (isProfiling) updateProfiler(blockCached, lastBlock);

        if (thread.status === Thread.STATUS_INTERRUPT && thread.continuous) {
            thread.status = STATUS_RUNNING;
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
