# sam-ui (Apache-2.0). Based on demo/frontend/frontend.Dockerfile from Meta's SAM 2 demo.
# Modified by sam-ui: builds studio with npm, and takes the backend URL at build time.

# Stage 1: build
FROM node:22.9.0 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The backend the built UI talks to (GraphQL at /graphql, streams at /track_*)
ARG VITE_API_ENDPOINT=http://localhost:7263
ARG VITE_OBJECT_LIMIT=16
ENV VITE_API_ENDPOINT=${VITE_API_ENDPOINT} VITE_OBJECT_LIMIT=${VITE_OBJECT_LIMIT}
RUN npm run build

# Stage 2: serve
FROM nginx:latest

COPY --from=build /app/dist /usr/share/nginx/html

CMD ["nginx", "-g", "daemon off;"]
