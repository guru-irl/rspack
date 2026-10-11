(function () {
  const defineProperties = Object.defineProperties;
  const defineProperty = Object.defineProperty;
  const parse = JSON.parse;
  return function (object, resource, request, userRequest, rawRequest, resourceResolveData, loaderPairs, type, derived, base, buildMeta, identifier, identifierSymbol) {
    object.resource = resource;
    object.request = request;
    object.userRequest = userRequest;
    object.rawRequest = rawRequest;
    object.resourceResolveData = resourceResolveData;
    object.loaders = parse(loaderPairs).map(([loader, type]) => ({
      loader, type, cache: false, data: null, normalExecuted: false,
      pitchExecuted: false, noPitch: false
    }));
    defineProperties(object, derived);
    object.type = type;
    defineProperties(object, base);
    object.buildMeta = buildMeta;
    defineProperty(object, identifierSymbol, { value: identifier, configurable: true });
  };
})()
