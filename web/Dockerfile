FROM oven/bun:1.3.14-alpine

WORKDIR /app

# Copy the whole project from the repository root so the server can resolve
# src/ and web/ with the same layout it uses locally.
COPY package.json bun.lock ./
COPY src/ ./src/
COPY web/ ./web/

RUN bun install --frozen-lockfile

EXPOSE 30303

# `serve start` stays in the foreground (runApiServer awaits forever), so this
# container hosts a real HTTP server instead of exiting after loading a module.
CMD ["sh", "-c", "exec bun run src/mind.ts serve start --port ${MIND_PORT:-30303}"]
