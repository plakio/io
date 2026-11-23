import WebSocket from "ws";

const {
  createWebSocketStream,
  extension,
  PerMessageDeflate,
  Receiver,
  Sender,
  subprotocol,
  WebSocketServer,
} = WebSocket;

export {
  createWebSocketStream,
  extension,
  PerMessageDeflate,
  Receiver,
  Sender,
  subprotocol,
  WebSocket,
  WebSocketServer,
};

export default WebSocket;
