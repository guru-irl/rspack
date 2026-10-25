module.exports = () => process.env.RSPACK_CODE_SPLITTING_CACHE_STABLE_ABSENCE === "1" || process.env.RSPACK_STABLE_ABSENCE_NEGATIVE_CONTROL === "1";
