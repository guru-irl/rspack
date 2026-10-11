(function () {
  const defineProperties = Object.defineProperties;
  const parse = JSON.parse;
  const data = value => ({ value, writable: true, enumerable: true, configurable: true });
  return function (object, resource, request, userRequest, rawRequest, resourceResolveData, loaderPairs, type, derived, base, buildMeta, identifier, identifierSymbol) {
    const loaders = parse(loaderPairs).map(([loader, type]) => ({
      loader, type, cache: false, data: null, normalExecuted: false,
      pitchExecuted: false, noPitch: false
    }));
    defineProperties(object, {
      resource: data(resource),
      request: data(request),
      userRequest: data(userRequest),
      rawRequest: data(rawRequest),
      resourceResolveData: data(resourceResolveData),
      loaders: data(loaders),
      ...derived,
      type: data(type),
      ...base,
      buildMeta: data(buildMeta),
      [identifierSymbol]: { value: identifier, configurable: true }
    });
  };
})()
