# Zeus - Build Server Architecture

## Overview

Zeus is an interactive CLI tool providing a beautiful and intuitive interface for Docker deployment workflows over SSH. The tool simplifies deployments by using a configuration file (`.zeusrc`) to store all deployment settings, and implements intelligent deployment strategies including blue-green deployments, health checks, and port-based container detection.

## Core Capabilities

- **Configuration-Driven** - Optional `.zeusrc` file for storing deployment settings
- **Multi-Platform Builds** - Support for AMD64, ARM64, and ARM v7 architectures
- **Blue-Green Deployment** - Zero-downtime deployments with staging validation
- **Health Checks** - Automatic container health validation before switchover
- **Port-Based Detection** - Smart detection of existing deployments by port mapping

## Architecture

### Configuration-Driven Deployment

Zeus can load deployment settings from a `.zeusrc` JSON configuration file, but it's optional. If the file doesn't exist, Zeus will prompt the user interactively for all required information:

```typescript
interface ZeusConfig {
  host: string;        // SSH hostname
  user: string;        // SSH username
  dockerfile?: string; // Path to Dockerfile
  platform?: string;   // Docker platform target
  image: string;       // Image name and tag
  ports?: string;      // Port mappings
  env?: string;        // Environment variables
}
```

**With `.zeusrc`:** Settings are loaded automatically  
**Without `.zeusrc`:** User is prompted for each value interactively

### Interactive Flow

The CLI accepts commands as arguments and executes them directly:

1. **Setup Command** - `zeus setup` prompts for SSH credentials and installs Docker
2. **Deploy Command** - `zeus deploy` loads `.zeusrc` config and executes full deployment

### User Experience Flow

#### Setup Flow
1. User runs `zeus setup`
2. Attempts to load host and user from `.zeusrc`
3. If config not found or missing fields, prompts for SSH credentials
4. Connects via SSH and installs Docker
5. Enables and starts Docker service

#### Deploy Flow
1. User runs `zeus deploy`
2. Attempts to load configuration from `.zeusrc`
3. If config not found, prompts user for all deployment settings
4. Displays configuration summary for confirmation
5. Builds Docker image locally with `docker buildx`
6. Transfers image via SSH pipe (`docker save | ssh | docker load`)
7. Runs container on remote with configured ports/env

### Core Operations

#### 1. Setup Docker (`setupSSHTarget`)
- Checks if Docker and BuildKit are already installed and working
- Skips installation if Docker is functional (idempotent operation)
- Installs Docker via official get.docker.com script if needed
- Enables and starts Docker service
- Safe to run multiple times on the same server

#### 2. Build Docker Image (`buildDockerImage`)
- Uses `docker buildx` for multi-platform support
- Supports AMD64, ARM64, and ARM v7 architectures
- Tags and loads image locally
- Reads Dockerfile path from config

#### 3. Transfer Image (`transferAndLoadImage`)
- Streams image via `docker save` over SSH
- Loads on remote server with `docker load`
- Efficient pipe-based transfer
- Auto-accepts SSH host keys

#### 4. Deploy Container (`runImageOnTarget`)

This function implements intelligent deployment strategies:

**Port-Based Detection:**
- Queries remote server for containers using the target port
- Finds existing deployments regardless of container name
- Displays detailed information about existing containers

**User Confirmation:**
- Shows existing container details (name, image, status, ID)
- Prompts user to confirm replacement
- Allows safe cancellation if wrong target identified

**Blue-Green Deployment** (when replacing existing):
1. Starts staging container on a temporary port (production port + 10000)
2. Health checks staging container for stability
3. Stops and removes old container if staging is healthy
4. Starts new container on production port
5. Cleans up staging container
6. Rolls back automatically if staging fails health check

**First-Time Deployment** (no existing container):
1. Starts container with configured ports and environment
2. Health checks the new container
3. Rolls back automatically if health check fails

**Container Naming:**
- Uses timestamp-based naming: `<image>-<timestamp>`
- Allows multiple deployments of same image to different ports
- Prevents naming conflicts

**Health Check Process:**
- Waits for container to initialize (2 seconds)
- Checks container status is "running"
- Verifies restart count is 0 (no crashes)
- Retries up to 5 times with 1-second intervals
- Returns false if container unhealthy or restarting

### Code Structure

```
src/
└── index.ts
    ├── ZeusConfig interface       # Type definition for .zeusrc
    ├── loadConfig()               # Read and parse .zeusrc file
    ├── setupSSHTarget()           # Idempotent Docker installation
    ├── buildDockerImage()         # Local image building
    ├── transferAndLoadImage()     # SSH transfer
    ├── parsePortMapping()         # Parse port string to host/container ports
    ├── generateContainerName()    # Generate timestamp-based container name
    ├── findContainerByPort()      # Find existing container using target port
    ├── healthCheckContainer()     # Validate container health and stability
    ├── runImageOnTarget()         # Blue-green deployment orchestration
    └── main()                     # CLI entry point with command routing
```

### User Experience

Zeus provides a command-line interface that accepts commands as arguments:

```bash
zeus setup   # Install Docker on remote server
zeus deploy  # Deploy application from .zeusrc config
```

The CLI uses @clack/prompts components for beautiful interactive prompts:

- `intro()` / `outro()` - Beautiful start/end messages
- `select()` - Menu choices with keyboard navigation
- `text()` - Text input with validation and placeholders
- `confirm()` - Yes/no confirmation before deployment
- `note()` - Display configuration details in a box
- `spinner()` - Real-time operation feedback with ✓/✗ indicators
- `cancel()` - Graceful cancellation messages
- `isCancel()` - Detection of user interrupts (Ctrl+C)

### SSH Security

All SSH commands include:
- `-o StrictHostKeyChecking=accept-new` - Auto-accepts new host keys
- `-o ConnectTimeout=10` - Prevents hanging on unreachable hosts

This allows seamless first-time connections while still verifying known hosts on subsequent connections.

### Build Process

TypeScript source in `src/` compiles to JavaScript in `dist/` via `tsc`, then runs with Node.js in ESM mode.

### Configuration File

The `.zeusrc` file is optional for local development but **required in CI environments**:
- Stored in project root
- JSON format for easy editing
- Gitignored by default (contains sensitive host info)
- Example template provided as `.zeusrc.example`
- Skips interactive prompts when present
- Optional fields have sensible defaults

**CI Environment Detection:**
- When `CI=true` or `CI=1` environment variable is set
- Deployment fails immediately if `.zeusrc` is not found
- Prevents interactive prompt hangs in automated pipelines
- Ensures reproducible deployments in CI/CD

Without `.zeusrc` in local development, Zeus prompts for values interactively, making it flexible for one-off deployments or first-time use.

## Benefits

1. **Zero-Downtime Deployments** - Blue-green strategy ensures service continuity
2. **Automatic Validation** - Health checks prevent broken deployments from reaching production
3. **Safe Rollback** - Failed deployments clean up automatically without user intervention
4. **Flexible Configuration** - Use `.zeusrc` for speed or interactive prompts for flexibility
5. **CI/CD Ready** - Required configuration in CI prevents deployment failures
6. **Port-Based Detection** - Smart detection allows multiple images on same server
7. **Idempotent Setup** - Safe to run setup multiple times without reinstalling Docker
8. **Reproducible Deployments** - Configuration can be stored in version control (template)
9. **Beautiful UI** - Modern, colorful prompts make deployments enjoyable
10. **Fast Iteration** - Quick redeploys with saved configuration or interactive mode

## Deployment Safety

Zeus implements multiple safety layers:

- **Health Checks**: Validates containers are running and stable before switchover
- **Staging Validation**: Tests new containers before touching production
- **User Confirmation**: Shows existing container details before replacement
- **Automatic Rollback**: Cleans up failed deployments automatically
- **Port Conflict Detection**: Identifies existing services on target ports
- **CI Enforcement**: Requires configuration in automated environments
