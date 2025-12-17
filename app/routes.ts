import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("computer/:name", "routes/computer.$name.tsx"),
] satisfies RouteConfig;
