import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("computer/:name/*", "routes/computer.$name.tsx"),
  route("api/computer/:name/do-id", "routes/api/computer.$name.do-id.ts"),
  route("api/computer/:name/files/*", "routes/api/computer.$name.files.$.ts"),
  route("api/computer/:name/logs", "routes/api/computer.$name.logs.ts"),
] satisfies RouteConfig;
