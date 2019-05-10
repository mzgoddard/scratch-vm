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
    return id.replace(/[^\w+_]/g, '_');
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
    toString () {
        return '';
    }
}
class JSWhitespace {}
class JSChunk extends JSNode {
    constructor ({index, statements}) {
        super();
        this.index = index;
        this.statements = statements;
    }
    toString () {
        return this.statements.join('');
    }
}
class JSStatement extends JSNode {
    constructor ({expr} = {}) {
        super();
        this.indent = new JSWhitespace();
        this.expr = expr;
    }
}
class JSExpressionStatement extends JSStatement {
    constructor ({expr}) {
        super({expr});
    }
    toString () {
        return `${this.expr};`;
    }
}
class JSCheckStatus extends JSStatement {
    toString () {
        return 'if (thread.status !== 0) return;';
    }
}
class JSStore extends JSStatement {
    constructor ({index, expr}) {
        super({expr});
        this.index = index;
    }
}
class JSStoreArg extends JSStore {
    constructor ({index, expr, name, key}) {
        super({index, expr});
        this.name = name;
        this.key = key;
    }
    toString () {
        return `${this.name}.${this.key} = ${this.expr};`;
    }
}
class JSStoreVar extends JSStore {
    constructor ({index, expr, name}) {
        super({index, expr});
        this.refs = 0;
        this.name = name;
    }
    toString () {
        if (this.refs === 0) return '';
        return `var ${this.name} = ${this.expr};`;
    }
}
class JSOperator extends JSNode {}
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
class JSCallMember extends JSCall {}
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
    constructor ({debugName}) {
        super();
        this.debugName = debugName;
        this.bindings = [];
        this.dereferences = [];
        this.chunks = [];
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
class JSPrinter {
    visit (node) {

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

    factoryAST.dereferences.push(new JSStoreVar({
        name: 'thread',
        expr: new JSProperty({
            lhs: 'blockUtility',
            member: 'thread'
        })
    }));

    const findVar = function (name) {
        return (
            factoryAST.dereferences.find(store => store.name === name) ||
            factoryAST.bindings.find(store => store.name === name)
        );
    }

    const addRef = function (name) {
        const node = findVar(name);
        if (node) node.refs++;
    };

    const removeRef = function (name) {
        const node = findVar(name);
        if (node) node.refs--;
    };

    const bind = function (i, name, value) {
        if (value && !bindings[name]) {
            bindings[name] = value;
            factoryAST.bindings.push(new JSStoreVar({
                index: i,
                name,
                expr: new JSProperty({
                    lhs: `bindings`,
                    member: name
                })
            }));
        }
    };

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const argValues = op._argValues;
        const func = op._blockFunctionUnbound;
        const context = op._blockFunctionContext;

        const id = findId(bindings, argValues, null, 'arg_');
        const contextId = findId(bindings, context, context && context.constructor.name, 'ctx_');
        const functionId = findId(bindings, func, op.opcode, 'fn_');

        bind(i, contextId, context);
        bind(i, functionId, func);
        bind(i, id, argValues);
    }

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const argValues = op._argValues;
        const parentValues = op._parentValues;
        const func = op._blockFunctionUnbound;
        const context = op._blockFunctionContext;

        const id = findId(bindings, argValues);
        const parentI = ops.findIndex(({_argValues}) => _argValues === parentValues);
        const parentId = parentI > -1 ? findId(bindings, parentValues) : null;
        const contextId = findId(bindings, context, context && context.constructor.name, 'ctx_');
        const functionId = findId(bindings, func, op.opcode, 'fn_');

        // let statement = JSNode.callBlock(contextId, functionId, id);
        // addRef(statement);
        let statement = new JSCallBlock({
            context: contextId,
            func: functionId,
            args: id
        });
        addRef(contextId);
        addRef(functionId);
        addRef(id);
        if (parentId) {
            // statement = JSNode.storeArg(i, parentId, op._parentKey, statement);
            statement = new JSStoreArg({
                index: i,
                name: `${parentId}`,
                key: `${op._parentKey}`,
                expr: statement
            });
        } else {
            // statement = JSNode.expressionStatement(statement);
            statement = new JSExpressionStatement({
                expr: statement
            });
        }
        // const chunk = JSNode.chunk(i, [statement, new JSCheckStatus()]);
        // factoryAST.chunks.push(chunk);
        factoryAST.chunks.push(new JSChunk({
            index: i,
            statements: [
                statement,
                new JSCheckStatus()
            ]
        }));
        addRef('thread');
    }

    for (let i = 0; i < factoryAST.chunks.length; i++) {
        const op = ops[i];
        const chunk = factoryAST.chunks[i];

        const context = op._blockFunctionContext;
        const func = op._blockFunctionUnbound;
        const funcsrc = func.toString();

        const statement = chunk.statements[0];
        let call;
        if (statement instanceof JSStoreArg) {
            call = statement.expr;
        } else if (statement instanceof JSExpressionStatement) {
            call = statement.expr;
        }

        if (!/this/.test(funcsrc)) {
            statement.expr = new JSCallFunction({
                func: call.func,
                args: call.args
            });
            removeRef(call.context);
        } else if (context) {
            const methodId = [
                ...Object.getOwnPropertyNames(context),
                ...Object.getOwnPropertyNames(Object.getPrototypeOf(context))
            ].find(key => context[key] === func);
            if (methodId && safeId(methodId) === methodId) {
                statement.expr = new JSCallFunction({
                    func: new JSProperty({
                        lhs: call.context,
                        member: methodId
                    }),
                    args: call.args
                });
                removeRef(call.func);
            }
        }

        if (
            // this opcode does not modify the thread status
            /^(operator|data|argument)/.test(op.opcode) ||
            // no need to check the last operation the function is done
            i === ops.length - 1
        ) {
            const before = chunk.statements.length;
            chunk.statements = chunk.statements
                .filter(stmt => !(stmt instanceof JSCheckStatus));
            const after = chunk.statements.length;
            for (let j = 0; j < (before - after); j++) removeRef('thread');
        }

        if (
            op.opcode === 'vm_may_continue' &&
            (
                // is the first operation
                i === 0 ||
                // or last opcode does not modify the stack
                /^(operator|data|argument)/.test(ops[i - 1].opcode)
            )
        ) {
            const call = chunk.statements[0].expr;
            call.context && removeRef(call.context);
            call.func && removeRef(call.func);
            removeRef(call.args);
            if (chunk.statements.length === 1) addRef('thread');

            if (i === ops.findIndex(({opcode}) => opcode === 'vm_may_continue') && i < ops.length - 1) {
                // the first vm_may_continue operation
                chunk.statements = [
                    new JSExpressionStatement({
                        expr: `if (thread.continuous) thread.reuseStackForNextBlock('${op._argValues.NEXT_STACK}')`
                    }),
                    new JSExpressionStatement({
                        expr: `else return thread.status = ${Thread.STATUS_INTERRUPT}`
                    })
                ];
                if (i === ops.length - 1) {
                    // also the last
                    chunk.statements[1] = new JSExpressionStatement({
                        expr: `thread.status = ${Thread.STATUS_INTERRUPT}`
                    });
                }
            } else if (i < ops.length - 1) {
                // not the first or last operation
                chunk.statements = [
                    new JSExpressionStatement({
                        expr: `thread.reuseStackForNextBlock('${op._argValues.NEXT_STACK}')`
                    })
                ];
            } else {
                // not the first but the last operation
                chunk.statements = [
                    new JSExpressionStatement({
                        expr: `thread.reuseStackForNextBlock(null)`
                    }),
                    new JSExpressionStatement({
                        expr: `thread.status = ${Thread.STATUS_INTERRUPT}`
                    })
                ];
                if (i === ops.findIndex(({opcode}) => opcode === 'vm_may_continue')) {
                    chunk.statements[0] = new JSExpressionStatement({
                        expr: `if (thread.continuous) thread.reuseStackForNextBlock(null)`
                    });
                }
            }
        }

        // if (/^operator_(add|subtract|multiply|divide)/.test(op.opcode)) {
        //     const argValues = op._argValues;
        //     const store1Index = ops.findIndex(({_parentValues, _parentKey}) => _parentValues === argValues && _parentKey === 'NUM1');
        //     const store2Index = ops.findIndex(({_parentValues, _parentKey}) => _parentValues === argValues && _parentKey === 'NUM2');
        //
        //     let store1Id = `${findId(bindings, argValues)}.NUM1`;
        //     if (store1Index > -1) {
        //         const chunk1 = factoryAST.chunks[store1Index];
        //         const stmt1 = chunk1.statements[0];
        //         if (stmt1 instanceof JSStoreArg) {
        //             store1Id = `var_${store1Index}`;
        //             chunk1.statements[0] = new JSStoreVar({
        //                 index: store1Index,
        //                 name: store1Id,
        //                 expr: stmt1.expr
        //             });
        //             chunk1.statements[0].refs = 1;
        //         }
        //     }
        //     let store2Id = `${findId(bindings, argValues)}.NUM2`;
        //     if (store2Index > -1) {
        //         const chunk2 = factoryAST.chunks[store2Index];
        //         const stmt2 = chunk2.statements[0];
        //         if (stmt2 instanceof JSStoreArg) {
        //             store2Id = `var_${store2Index}`;
        //             chunk2.statements[0] = new JSStoreVar({
        //                 index: store2Index,
        //                 name: store2Id,
        //                 expr: stmt2.expr
        //             });
        //             chunk2.statements[0].refs = 1;
        //         }
        //     }
        //
        //     let operator = '+';
        //     if (op.opcode === 'operator_subtract') operator = '-';
        //     if (op.opcode === 'operator_multiply') operator = '*';
        //     if (op.opcode === 'operator_divide') operator = '/';
        //
        //     const expr = chunk.statements[0].expr;
        //     if (store1Index > -1 && store2Index > -1) {
        //         removeRef(expr.args);
        //     }
        //
        //     chunk.statements[0].expr = new JSBinaryOperator({
        //         operator,
        //         input1: store1Id,
        //         input2: store2Id
        //     });
        // }
    }

    // for (let i = 0; i < ops.length; i++) {
    //     const op = ops[i];
    //
    //     const id = compileId(i);
    //     bindings.args[id] = op._argValues;
    //
    //     const context = op._blockFunctionContext;
    //     let contextId;
    //
    //     const func = op._blockFunctionUnbound;
    //     let functionId;
    //     if (context) {
    //         for (const key of [
    //             ...Object.getOwnPropertyNames(context),
    //             ...Object.getOwnPropertyNames(Object.getPrototypeOf(context))
    //         ]) {
    //             if (context[key] === func) {
    //                 functionId = key;
    //                 break;
    //             }
    //         }
    //     }
    //
    //     const supportReturn = /return|=>/.test(func.toString());
    //     const supportThis = /this/.test(func.toString());
    //     const beforeLastOp = i < ops.length - 1;
    //     const needStatus = !/^(data|operator|argument)/.test(op.opcode);
    //     const isMayContinue = op.opcode === 'vm_may_continue';
    //     const afterStackChange = i > 0 && /^(control|procedure)/.test(ops[i - 1].opcode);
    //     const checkContinuous = ops.findIndex(({opcode}) => opcode === op.opcode) === i;
    //     const supportStatusChange = beforeLastOp && (
    //         isMayContinue ? (checkContinuous || afterStackChange) : needStatus
    //     );
    //     // const supportStatusChange = beforeLastOp && needStatus;
    //
    //     const isDataVariable = op.opcode === 'data_variable';
    //     const isBinaryOperator = /^operator_(add|subtract|multiply|divide)/.test(op.opcode);
    //
    //     if (isMayContinue && beforeLastOp && !checkContinuous && !afterStackChange) {
    //         delete bindings.args[id];
    //         source += `    thread.reuseStackForNextBlock('${op._argValues.NEXT_STACK}');\n`;
    //         continue;
    //     }
    //     if (supportReturn) {
    //         const parentValues = op._parentValues;
    //         let parentI = ops.findIndex(op => op._argValues === parentValues);
    //         let parentId;
    //         if (parentI === -1) {
    //             parentI = i;
    //             // bindings.out[compileId(parentI)] = parentValues;
    //             parentId = `out_${compileId(parentI)}`;
    //             source += `    `;
    //         } else {
    //             const isParentOperator = /^operator_(add|subtract|multiply|divide)/.test(ops[parentI].opcode);
    //             if (isParentOperator) {
    //                 parentId = `var_${id}`;
    //                 source += `    var ${parentId} = `;
    //             } else {
    //                 parentId = `arg_${compileId(parentI)}`;
    //                 source += `    ${parentId}.${op._parentKey} = `;
    //             }
    //         }
    //     } else source += '    ';
    //     if (isDataVariable) {
    //         source += `thread.target.lookupOrCreateVariable('${op._argValues.VARIABLE.id}', '${op._argValues.VARIABLE.name}').value;\n`;
    //         continue;
    //     }
    //     if (isBinaryOperator) {
    //         const aIndex = ops.findIndex(a => a._parentValues === op._argValues && a._parentKey === 'NUM1');
    //         const aId = aIndex === -1 ? `arg_${id}.NUM1` : `var_${compileId(aIndex)}`;
    //         const bIndex = ops.findIndex(b => b._parentValues === op._argValues && b._parentKey === 'NUM2');
    //         const bId = bIndex === -1 ? `arg_${id}.NUM2` : `var_${compileId(bIndex)}`;
    //         if (aIndex > -1 && bIndex > -1) {
    //             delete bindings.args[id];
    //         }
    //         let operator = '+';
    //         if (op.opcode === 'operator_subtract') operator = '-';
    //         if (op.opcode === 'operator_multiply') operator = '*';
    //         if (op.opcode === 'operator_divide') operator = '/';
    //
    //         bindings.functions['toNumber'] = Cast.toNumber;
    //         source += `toNumber(${aId}) ${operator} toNumber(${bId});\n`;
    //         continue;
    //     }
    //     if (supportThis) {
    //         contextId = (Object.entries(bindings.contexts).find(([_, ctx]) => ctx === context) || [])[0];
    //         if (context && !contextId) {
    //             contextId = context.constructor.name;
    //             if (bindings.contexts[contextId]) {
    //                 contextId = `ctx_${compileId(Object.keys(bindings.contexts).length)}`;
    //             }
    //             bindings.contexts[contextId] = context;
    //         } else if (!context) {
    //             contextId = 'null';
    //         }
    //     }
    //     if (functionId && supportThis) {
    //         source += `${contextId}.${functionId}(arg_${id}, blockUtility);\n`;
    //     } else {
    //         functionId = op.opcode;
    //         if (!bindings.functions[functionId]) {
    //             bindings.functions[functionId] = func;
    //         } else if (bindings.functions[functionId] !== func) {
    //             const functionI = Object.values(bindings.functions).indexOf(func);
    //             if (functionI === -1) {
    //                 functionId = compileId(Object.keys(bindings.functions).length);
    //                 bindings.functions[functionId] = func;
    //             } else {
    //                 functionId = compileId(functionI);
    //             }
    //         }
    //         if (supportThis) {
    //             source += `${functionId}.call(${contextId}, arg_${id}, blockUtility);\n`;
    //         } else {
    //             source += `${functionId}(arg_${id}, blockUtility);\n`;
    //         }
    //     }
    //     if (supportStatusChange) {
    //         source += `    if (thread.status !== 0) return;\n`;
    //     }
    // }
    //
    // const factory = new Function('bindings', [
    //     ...Object.keys(bindings.contexts)
    //         .map(key => `const ${key} = bindings.contexts.${key};`),
    //     ...Object.keys(bindings.functions)
    //         .map(key => `const ${key} = bindings.functions.${key};`),
    //     ...Object.keys(bindings.out)
    //         .map(key => `const out_${key} = bindings.args.${key};`),
    //     ...Object.keys(bindings.args)
    //         .map(key => `const arg_${key} = bindings.args.${key};`),
    //     `return function ${blockCached.opcode}_${ops.length} (_, blockUtility) {`,
    //     // `    window.COMILE_USE = (window.COMILE_USE | 0) + 1;`,
    //     '    const thread = blockUtility.thread;',
    //     source,
    //     `};`
    // ].join('\n'));

    const factory = new Function('bindings', factoryAST.toString());

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
