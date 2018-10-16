const Cast = require('../util/cast');

class BlockDefinition {
    constructor (def, children) {
        this.threading = new (def.threading || BlockDefinitionThreading)(Object.values(children));

        this.arguments = {};
        for (const key in def.arguments) {
            this.arguments[key] = new (def.arguments[key] || BlockDefinitionType)(children[key]);
        }

        this.return = new (def.return || BlockDefinitionType)(this);
    }

    static decorateBlockFunctions (proto) {
        for (const key of Object.getOwnPropertyNames(proto.prototype)) {
            if (typeof proto.prototype[key] === 'function' && `${key}_definition` in proto) {
                const definition = proto[`${key}_definition`];
                proto.prototype[key].definition = function (children) {
                    return new BlockDefinition(definition, children);
                };
                proto.prototype[key].definition.definition = Object.assign({}, definition);
            }
        }
    }
}

module.exports = BlockDefinition;

class BlockDefinitionThreading {
    constructor (children) {
        this.children = children;
    }

    isSync () {
        return false;
    }
}

class BlockDefinitionSynchronousThreading extends BlockDefinitionThreading {
    isSync () {
        if (this.children.length > 0) {
            return this.children.every(child => child && child.threading.isSync());
        }
        return true;
    }
}

BlockDefinitionThreading.Synchronous = BlockDefinitionSynchronousThreading;

class BlockDefinitionYieldsThreading extends BlockDefinitionThreading {}

BlockDefinitionThreading.Yields = BlockDefinitionYieldsThreading;

class BlockDefinitionPromiseThreading extends BlockDefinitionThreading {}

BlockDefinitionThreading.Promise = BlockDefinitionPromiseThreading;

BlockDefinition.Threading = BlockDefinitionThreading;

class BlockDefinitionType {
    constructor (child) {
        this.child = child;
    }

    mustCast () {
        return false;
    }

    castNumber () {
        return false;
    }

    castNan () {
        return false;
    }
}

class BlockDefinitionNumberType extends BlockDefinitionType {
    mustCast () {
        if (this.child.return instanceof BlockDefinitionNanSafeType) {
            return false;
        }
        return true;
    }

    castNumber () {
        if (this.child.return instanceof BlockDefinitionNumberType) {
            return false;
        }
        return true;
    }

    castNan () {
        if (this.child.return instanceof BlockDefinitionNanSafeType) {
            return false;
        }
        return true;
    }
}

BlockDefinitionType.Number = BlockDefinitionNumberType;

class BlockDefinitionNanSafeType extends BlockDefinitionNumberType {}

BlockDefinitionType.NanSafe = BlockDefinitionNanSafeType;

BlockDefinition.Type = BlockDefinitionType;
