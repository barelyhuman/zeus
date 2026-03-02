# Zeus - Docker Build Server

Interactive CLI tool written in TypeScript using [@clack/prompts](https://bomb.sh/docs/clack/) for building and deploying Docker images on a remote SSH server.

## Features

- **Interactive UI** - Beautiful prompts guide you through each step  
- **Docker Integration** - Build, transfer, and run containers seamlessly  
- **SSH Deployment** - Deploy directly to remote servers  
- **Multi-platform Builds** - Support for AMD64, ARM64, and ARM v7  
- **Configuration File** - Store deployment settings in `.zeusrc`  
- **Simple Workflow** - Just two commands: `setup` and `deploy`  
- **Blue-Green Deployment** - Zero-downtime deployments with health checks  
- **Port-Based Detection** - Smart detection of existing containers by port  
- **Health Checks** - Automatic validation of container health before switchover

## Requirements

- Node.js 18+ with npm
- Docker with buildx support
- SSH access to target server (password or key-based authentication)

**Note:** The CLI automatically accepts new SSH host keys on first connection for seamless deployment.

## Setup

```sh
npm install
npm run build
```

## Configuration

Zeus can read deployment settings from a `.zeusrc` file in your project root. If the file doesn't exist, Zeus will prompt you for the information interactively.

**In CI environments** (when `CI=true` or `CI=1`), the `.zeusrc` file is **required** and the deployment will fail if it's not found.

**Optional: Create a `.zeusrc` file to skip prompts:**

```json
{
  "host": "example.com",
  "user": "ubuntu",
  "dockerfile": "./Dockerfile",
  "platform": "linux/amd64",
  "image": "my-app:latest",
  "ports": "8080:80",
  "env": "NODE_ENV=production"
}
```

See [.zeusrc.example](.zeusrc.example) for a template.

### Configuration Options

- `host` (required) - SSH hostname or IP address
- `user` (required) - SSH username
- `image` (required) - Docker image name and tag
- `dockerfile` (optional) - Path to Dockerfile (default: `./Dockerfile`)
- `platform` (optional) - Target platform (default: `linux/amd64`)
- `ports` (optional) - Port mapping (e.g., `8080:80` or `80:80,443:443`)
- `env` (optional) - Environment variables (e.g., `NODE_ENV=production,API_KEY=secret`)

## Usage

Zeus accepts commands as arguments:

```sh
# Setup Docker on remote server (one-time)
npx setup

# Deploy your application
node dist/index.js deploy

# Or use npm scripts
npx @barelyhuman/zeus setup
npx @barelyhuman/zeus deploy
```

Or install globally and use the `zeus` command:

```sh
npm i -g @barelyhuman/zeus
zeus setup
zeus deploy
```

### Commands

#### `zeus setup`

Installs Docker and BuildKit on your remote server. This command is idempotent - it checks if Docker is already installed and only installs if needed.

```sh
zeus setup
```

The setup command:
- Checks if Docker and BuildKit are already installed and working
- Skips installation if Docker is already functional
- Installs Docker via the official get.docker.com script if needed
- Enables and starts the Docker service

If a `.zeusrc` file exists with `host` and `user` fields, Zeus will use those. Otherwise, you'll be prompted for:
- SSH host
- SSH user

#### `zeus deploy`

Builds your Docker image locally, transfers it to the target server, and runs it with intelligent deployment strategies.

```sh
zeus deploy
```

If a `.zeusrc` file exists, Zeus will use those settings. Otherwise (except in CI), you'll be prompted for:
- SSH host
- SSH user  
- Dockerfile path
- Target platform
- Image name
- Port mappings (optional)
- Environment variables (optional)

**Deployment Process:**

1. Load configuration from `.zeusrc` (required in CI, optional otherwise)
2. Show deployment settings and ask for confirmation
3. Build the Docker image for the specified platform
4. Transfer the image to the target server
5. Check if a container is already using the target port
6. If existing container found:
   - Display existing container details (name, image, status, ID)
   - Ask for confirmation to replace it
   - Start a staging container on a different port
   - Health check the staging container
   - Stop and remove the old container
   - Start the new container on the production port
   - Clean up the staging container
7. If no existing container:
   - Start the container directly
   - Health check the new container

**Health Checks:** Each deployment validates that containers are running properly and haven't restarted before considering them healthy.

**Blue-Green Deployment:** When replacing an existing container, Zeus uses a blue-green strategy to minimize downtime by validating the new version before switching traffic.

## Example Workflow

### First Time Setup

1. Optionally create a `.zeusrc` file with at least `host` and `user` fields
2. Run `zeus setup` (or `node dist/index.js setup`)
3. If no `.zeusrc` exists, answer the prompts for host and user
4. Wait for Docker installation to complete

### Deploying

1. Make changes to your application
2. Run `zeus deploy` (or `node dist/index.js deploy`)
3. If no `.zeusrc` exists, answer the prompts or create one for future deployments
4. Confirm the deployment settings
5. Watch as your app builds, transfers, and starts! 🎉

## Architecture

Detailed architecture can be found in [docs/ARCH.md](docs/ARCH.md).
