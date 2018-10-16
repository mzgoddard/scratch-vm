const Cast = require('../util/cast.js');
const MathUtil = require('../util/math-util.js');
const BlockDefinition = require('../engine/block-definition');

class Scratch3OperatorsBlocks {
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
            operator_add: this.add,
            operator_subtract: this.subtract,
            operator_multiply: this.multiply,
            operator_divide: this.divide,
            operator_lt: this.lt,
            operator_equals: this.equals,
            operator_gt: this.gt,
            operator_and: this.and,
            operator_or: this.or,
            operator_not: this.not,
            operator_random: this.random,
            operator_join: this.join,
            operator_letter_of: this.letterOf,
            operator_length: this.length,
            operator_contains: this.contains,
            operator_mod: this.mod,
            operator_round: this.round,
            operator_mathop: this.mathop
        };
    }

    static get add_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            arguments: {
                NUM1: BlockDefinition.Type.Number,
                NUM2: BlockDefinition.Type.Number
            },
            return: BlockDefinition.Type.NanSafe
        };
    }

    add (args) {
        return args.NUM1 + args.NUM2;
    }

    static get subtract_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            arguments: {
                NUM1: BlockDefinition.Type.Number,
                NUM2: BlockDefinition.Type.Number
            },
            return: BlockDefinition.Type.NanSafe
        };
    }

    subtract (args) {
        return args.NUM1 - args.NUM2;
    }

    static get multiply_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            arguments: {
                NUM1: BlockDefinition.Type.Number,
                NUM2: BlockDefinition.Type.Number
            },
            return: BlockDefinition.Type.NanSafe
        };
    }

    multiply (args) {
        return args.NUM1 * args.NUM2;
    }

    static get divide_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            arguments: {
                NUM1: BlockDefinition.Type.Number,
                NUM2: BlockDefinition.Type.Number
            },
            return: BlockDefinition.Type.Number
        };
    }

    divide (args) {
        return args.NUM1 / args.NUM2;
    }

    static get lt_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            arguments: {
                OPERAND1: BlockDefinition.Type,
                OPERAND2: BlockDefinition.Type
            },
            return: BlockDefinition.Type.Boolean
        };
    }

    lt (args) {
        // console.log('lt', args.OPERAND1, args.OPERAND2, Cast.compare(args.OPERAND1, args.OPERAND2) < 0);
        return Cast.compare(args.OPERAND1, args.OPERAND2) < 0;
    }

    static get equals_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            arguments: {
                OPERAND1: BlockDefinition.Type,
                OPERAND2: BlockDefinition.Type
            },
            return: BlockDefinition.Type.Boolean
        };
    }

    equals (args) {
        return Cast.compare(args.OPERAND1, args.OPERAND2) === 0;
    }

    static get gt_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            arguments: {
                OPERAND1: BlockDefinition.Type,
                OPERAND2: BlockDefinition.Type
            },
            return: BlockDefinition.Type.Boolean
        };
    }

    gt (args) {
        return Cast.compare(args.OPERAND1, args.OPERAND2) > 0;
    }

    static get and_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            arguments: {
                OPERAND1: BlockDefinition.Type.Boolean,
                OPERAND2: BlockDefinition.Type.Boolean
            },
            return: BlockDefinition.Type.Boolean
        };
    }

    and (args) {
        return Cast.toBoolean(args.OPERAND1) && Cast.toBoolean(args.OPERAND2);
    }

    static get or_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            arguments: {
                OPERAND1: BlockDefinition.Type.Boolean,
                OPERAND2: BlockDefinition.Type.Boolean
            },
            return: BlockDefinition.Type.Boolean
        };
    }

    or (args) {
        return Cast.toBoolean(args.OPERAND1) || Cast.toBoolean(args.OPERAND2);
    }

    static get not_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            arguments: {
                OPERAND: BlockDefinition.Type.Boolean
            },
            return: BlockDefinition.Type.Boolean
        };
    }

    not (args) {
        return !Cast.toBoolean(args.OPERAND);
    }

    static get random_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            arguments: {
                FROM: BlockDefinition.Type.Number,
                TO: BlockDefinition.Type.Number
            },
            return: BlockDefinition.Type.NanSafe
        };
    }

    random (args) {
        const nFrom = args.FROM;
        const nTo = args.TO;
        const low = nFrom <= nTo ? nFrom : nTo;
        const high = nFrom <= nTo ? nTo : nFrom;
        if (low === high) return low;
        // If both arguments are ints, truncate the result to an int.
        if (Cast.isInt(args.FROM) && Cast.isInt(args.TO)) {
            return low + Math.floor(Math.random() * ((high + 1) - low));
        }
        return (Math.random() * (high - low)) + low;
    }

    join (args) {
        return Cast.toString(args.STRING1) + Cast.toString(args.STRING2);
    }

    letterOf (args) {
        const index = Cast.toNumber(args.LETTER) - 1;
        const str = Cast.toString(args.STRING);
        // Out of bounds?
        if (index < 0 || index >= str.length) {
            return '';
        }
        return str.charAt(index);
    }

    length (args) {
        return Cast.toString(args.STRING).length;
    }

    contains (args) {
        const format = function (string) {
            return Cast.toString(string).toLowerCase();
        };
        return format(args.STRING1).includes(format(args.STRING2));
    }

    static get mod_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            arguments: {
                NUM1: BlockDefinition.Type.Number,
                NUM2: BlockDefinition.Type.Number
            },
            return: BlockDefinition.Type.Number
        };
    }

    mod (args) {
        const n = args.NUM1;
        const modulus = args.NUM2;
        let result = n % modulus;
        // Scratch mod is kept positive.
        if (result / modulus < 0) result += modulus;
        return result;
    }

    static get round_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            arguments: {
                NUM: BlockDefinition.Type.Number
            },
            return: BlockDefinition.Type.Number
        };
    }

    round (args) {
        return Math.round(args.NUM);
    }

    static get mathop_definition () {
        return {
            threading: BlockDefinition.Threading.Synchronous,
            arguments: {
                NUM: BlockDefinition.Type.Number,
                OPERATOR: BlockDefinition.Type.String
            },
            return: BlockDefinition.Type.Number
        };
    }

    mathop (args) {
        const operator = Cast.toString(args.OPERATOR).toLowerCase();
        const n = args.NUM;
        switch (operator) {
        case 'abs': return Math.abs(n);
        case 'floor': return Math.floor(n);
        case 'ceiling': return Math.ceil(n);
        case 'sqrt': return Math.sqrt(n);
        case 'sin': return parseFloat(Math.sin((Math.PI * n) / 180).toFixed(10));
        case 'cos': return parseFloat(Math.cos((Math.PI * n) / 180).toFixed(10));
        case 'tan': return MathUtil.tan(n);
        case 'asin': return (Math.asin(n) * 180) / Math.PI;
        case 'acos': return (Math.acos(n) * 180) / Math.PI;
        case 'atan': return (Math.atan(n) * 180) / Math.PI;
        case 'ln': return Math.log(n);
        case 'log': return Math.log(n) / Math.LN10;
        case 'e ^': return Math.exp(n);
        case '10 ^': return Math.pow(10, n);
        }
        return 0;
    }
}

BlockDefinition.decorateBlockFunctions(Scratch3OperatorsBlocks);

module.exports = Scratch3OperatorsBlocks;
