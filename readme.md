python3 -m http.server 8000

goto http://localhost:8000/, zoom in/out, click on small sprites


updated:


in demoA and demoB, run PORT=8082 node server.js and PORT=8081 node server.js

in localhost:8082, add an annotation, sync with localhost:8081, then in localhost:8081 sync with localhost:8082. 
the annotation from localhost:8082 shows up

## Configuration

To connect to a different backend API, edit `config.js` and update the `API_BASE` URL:

```javascript
window.APP_CONFIG = {
  API_BASE: "http://your-backend-ip:3001"
};
```

The default is `http://localhost:3001`. Change this to point to any backend on your network.