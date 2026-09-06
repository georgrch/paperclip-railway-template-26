FROM node:24.11-bookworm-slim

# Install gosu (privilege dropping in entrypoint) and ca-certificates.
# ca-certificates is required: node:20-slim ships without the system CA bundle, and the
# agent CLIs (codex/claude) use the OS trust store for TLS to api.openai.com / api.anthropic.com.
# Without it, agent runs fail with "no native root CA certificates found". (Node's own fetch is
# unaffected because Node bundles its own CAs.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gosu \
    ca-certificates \
    git \
    ripgrep \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install OpenCode CLI
RUN npm install -g opencode-ai \
    && opencode --version

# Create a non-root user (required: Claude CLI refuses --dangerously-skip-permissions as root)
RUN groupadd -r paperclip && useradd -r -g paperclip -m -d /home/paperclip -s /bin/bash paperclip

# Create the paperclip home directory (Railway volume mount point)
RUN mkdir -p /paperclip && chown -R paperclip:paperclip /paperclip

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --omit=dev --package-lock=false

# Copy application code
COPY . .

# Reapply optional cost reporting after every upstream install. Incompatible
# adapter changes disable the patch with a warning, keeping updates possible.
RUN npm test && npm run build

# Give ownership of everything to the non-root user
RUN chown -R paperclip:paperclip /app /home/paperclip

# Copy and set up entrypoint (fixes volume mount ownership at runtime)
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Railway injects PORT at runtime (default 3100)
ENV PORT=3100
EXPOSE 3100

# Entrypoint runs as root to fix volume permissions, then drops to paperclip user
ENTRYPOINT ["/entrypoint.sh"]
CMD ["npm", "start"]
