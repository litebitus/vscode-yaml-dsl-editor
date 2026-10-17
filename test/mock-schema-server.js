const http = require('http');

function mockSchemaServer() {
  const documents = new Map();
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ path: request.url, headers: request.headers });
    const served = documents.get(url.pathname);
    if (!served) {
      response.writeHead(404);
      response.end();
      return;
    }
    const validators = {};
    if (served.entityTag) validators.ETag = served.entityTag;
    if (served.lastModified) validators['Last-Modified'] = served.lastModified;
    const unchanged = (served.entityTag && request.headers['if-none-match'] === served.entityTag)
      || (served.lastModified && request.headers['if-modified-since'] === served.lastModified);
    response.writeHead(unchanged ? 304 : 200, validators);
    response.end(unchanged ? undefined : served.text);
  });
  return {
    requests,
    serve: (pathname, served) => documents.set(pathname, served),
    urlOf: (pathAndQuery) => `http://127.0.0.1:${server.address().port}${pathAndQuery}`,
    start: () => new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); }),
    stop: () => new Promise((resolve) => { server.close(resolve); }),
  };
}

module.exports = { mockSchemaServer };
