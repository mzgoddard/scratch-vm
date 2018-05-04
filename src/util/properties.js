const findInCache = function (cache, key) {
    for (let i = 0; i < cache.ids.length; i++) {
        if (cache.ids[i] === key) {
            if (i !== 0) {
                swapToFront(cache, i);
                i = 0;
            }
            return i;
        }
    }
    return -1;
}

const swapToFront = function (cache, index) {
    const tmpId = cache.ids[0];
    const tmp = cache.values[0];
    cache.ids[0] = cache.ids[index];
    cache.values[0] = cache.values[index];
    cache.ids[index] = tmpId;
    cache.values[index] = tmp;
};

const addToCache = function (cache, key, value) {
    cache.ids.unshift(key);
    cache.values.unshift(value);
    if (cache.ids.length > 10) {
        cache.ids.pop();
        cache.values.pop();
    }
};

module.exports = {
    createCache () {
        return {
            ids: [],
            values: []
        };
    },

    has (obj, cache, key) {
        const index = findInCache(cache, key);
        if (index >= 0) {
            return true;
        }

        // If we have a local copy, return it.
        if (obj.hasOwnProperty(key)) {
            addToCache(cache, key, obj[key]);
            return true;
        }

        return false;
    },

    set (obj, cache, key, value) {
        const index = findInCache(cache, key);
        if (index >= 0) {
            cache.values[index] = value;
            obj[key] = value;
            return value;
        }

        // If we have a local copy, return it.
        if (obj.hasOwnProperty(key)) {
            addToCache(cache, key, value);
            obj[key] = value;
            return value;
        }
    },

    get (obj, cache, key) {
        const index = findInCache(cache, key);
        if (index >= 0) {
            return cache.values[index];
        }

        // If we have a local copy, return it.
        if (obj.hasOwnProperty(key)) {
            addToCache(cache, key, obj[key]);
            return obj[key];
        }
    }
};
