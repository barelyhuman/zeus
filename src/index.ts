#!/usr/bin/env node
import {
  cancel,
  confirm,
  intro,
  isCancel,
  note,
  outro,
  select,
  spinner,
  text,
} from '@clack/prompts'
import { execa } from 'execa'
import { access, readFile } from 'fs/promises'
import { join } from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

interface ZeusConfig {
  host: string
  user: string
  dockerfile?: string
  platform?: string
  image: string
  ports?: string
  env?: string
}

/**
 * Validates and sanitizes SSH user input to prevent CLI injection
 * Valid SSH usernames typically contain alphanumeric characters, hyphens, underscores, and dots
 */
function sanitizeSSHUser(user: string): string {
  if (!user || typeof user !== 'string') {
    throw new Error('SSH user is required and must be a string')
  }

  // SSH usernames should only contain safe characters
  // Based on POSIX portable filename character set plus common SSH username chars
  const sanitized = user.trim()
  const validPattern = /^[a-zA-Z0-9._-]+$/

  if (!validPattern.test(sanitized)) {
    throw new Error(
      'Invalid SSH user format. Only alphanumeric characters, periods, hyphens, and underscores are allowed.'
    )
  }

  if (sanitized.length > 32) {
    throw new Error('SSH user must be 32 characters or less')
  }

  return sanitized
}

/**
 * Validates and sanitizes SSH host input to prevent CLI injection
 * Valid hostnames/IPs should follow standard hostname or IP address patterns
 */
function sanitizeSSHHost(host: string): string {
  if (!host || typeof host !== 'string') {
    throw new Error('SSH host is required and must be a string')
  }

  const sanitized = host.trim()

  // Check for IPv4 address
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/
  // Check for IPv6 address (basic pattern)
  const ipv6Pattern = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/

  if (
    !ipv4Pattern.test(sanitized) &&
    !ipv6Pattern.test(sanitized) &&
    !/^[a-zA-Z0-9.-]+$/.test(sanitized)
  ) {
    throw new Error(
      'Invalid SSH host format. Must be a valid IP address or hostname.'
    )
  }

  return sanitized
}

function sanitisePort(port: string): string {
  const sanitised = port.replace(/[^0-9:]/g, '')
  if (port.length !== sanitised.length) {
    throw new Error(
      'Invalid port format. Only numeric characters and colons are allowed.'
    )
  }
  return sanitised
}

async function loadConfig(): Promise<ZeusConfig | null> {
  const configPath = join(process.cwd(), '.zeusrc')

  try {
    await access(configPath)
    const content = await readFile(configPath, 'utf-8')
    const config = JSON.parse(content)
    return config
  } catch (error) {
    return null
  }
}

async function setupSSHTarget(host: string, user: string) {
  // Sanitize inputs to prevent CLI injection
  const safeUser = sanitizeSSHUser(user)
  const safeHost = sanitizeSSHHost(host)
  const sshTarget = `${safeUser}@${safeHost}`

  const s = spinner()
  s.start(`Checking Docker installation on ${sshTarget}`)

  try {
    // Check if Docker is already installed and working
    const dockerCheck = await execa(
      'ssh',
      [
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=10',
        sshTarget,
        'docker --version && docker ps',
      ],
      { reject: false }
    )

    // Check if BuildKit is available
    const buildxCheck = await execa(
      'ssh',
      [
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=10',
        sshTarget,
        'docker buildx version',
      ],
      { reject: false }
    )

    if (dockerCheck.exitCode === 0 && buildxCheck.exitCode === 0) {
      s.stop('✓ Docker and BuildKit are already installed and working')
      return
    }

    // Docker not installed or not working, proceed with installation
    s.message(`Installing Docker and BuildKit on ${sshTarget}`)

    const commands = [
      'sudo apt-get update',
      'sudo apt remove -y $(dpkg --get-selections docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc | cut -f1) 2>/dev/null || true',
      'curl -fsSL https://get.docker.com -o get-docker.sh',
      'sudo sh get-docker.sh',
      'sudo systemctl enable docker',
      'sudo systemctl start docker',
    ]

    for (const cmd of commands) {
      await execa('ssh', [
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=10',
        sshTarget,
        cmd,
      ])
    }

    s.stop('✓ Docker and BuildKit setup complete')
  } catch (error) {
    s.stop('✗ Setup failed')
    throw error
  }
}

async function buildDockerImage(
  dockerfile: string,
  platform: string,
  imageName: string
) {
  const s = spinner()
  s.start(`Building Docker image for ${platform}`)

  try {
    await execa(
      'docker',
      [
        'buildx',
        'build',
        '--platform',
        platform,
        '-f',
        dockerfile,
        '-t',
        imageName,
        '--load',
        '.',
      ],
      { stdio: 'pipe' }
    )
    s.stop('✓ Docker image built successfully')
  } catch (error) {
    s.stop('✗ Build failed')
    throw error
  }
}

async function transferAndLoadImage(host: string, user: string, image: string) {
  // Sanitize inputs to prevent CLI injection
  const safeUser = sanitizeSSHUser(user)
  const safeHost = sanitizeSSHHost(host)
  const sshTarget = `${safeUser}@${safeHost}`

  const s = spinner()
  s.start(`Transferring ${image} to ${sshTarget}`)

  try {
    // Stream docker save directly to ssh docker load to avoid buffering
    // This prevents memory issues with large images
    const dockerSave = execa('docker', ['save', image], {
      stdout: 'pipe',
      stderr: 'pipe',
      buffer: false, // Don't buffer output in memory
    })

    const sshDockerLoad = execa(
      'ssh',
      [
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=10',
        sshTarget,
        'docker load',
      ],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        buffer: false, // Don't buffer output in memory
      }
    )

    // Set up proper stream piping with error handling
    if (dockerSave.stdout && sshDockerLoad.stdin) {
      dockerSave.stdout.pipe(sshDockerLoad.stdin)

      // Handle backpressure by pausing/resuming the source stream
      sshDockerLoad.stdin.on('error', err => {
        dockerSave.kill()
        throw err
      })

      dockerSave.stdout.on('error', err => {
        sshDockerLoad.kill()
        throw err
      })
    }

    // Wait for both processes to complete
    const [saveResult, loadResult] = await Promise.all([
      dockerSave,
      sshDockerLoad,
    ])

    s.stop('✓ Image transferred and loaded')
  } catch (error) {
    s.stop('✗ Transfer failed')
    throw error
  }
}

function parsePortMapping(
  ports: string
): { hostPort: string; containerPort: string } | null {
  if (!ports) return null
  const match = ports.match(/^(\d+):(\d+)$/)
  if (!match) return null
  return { hostPort: match[1], containerPort: match[2] }
}

function generateContainerName(baseImage: string): string {
  // Use timestamp for unique container name
  const timestamp = Date.now()
  const imagePart = baseImage
    .split(':')[0]
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .substring(0, 30)
  return `${imagePart}-${timestamp}`
}

async function findContainerByPort(
  host: string,
  user: string,
  hostPort: string
): Promise<{ name: string; image: string; status: string; id: string } | null> {
  // Sanitize inputs to prevent CLI injection
  const safeUser = sanitizeSSHUser(user)
  const safeHost = sanitizeSSHHost(host)
  const sshTarget = `${safeUser}@${safeHost}`

  try {
    // Find container using the specified port
    const result = await execa(
      'ssh',
      [
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=10',
        sshTarget,
        `docker ps -a --filter publish=${hostPort} --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.ID}}'`,
      ],
      { reject: false }
    )

    if (!result.stdout.trim()) {
      return null
    }

    const [name, image, status, id] = result.stdout.trim().split('|')
    return { name, image, status, id }
  } catch (error) {
    return null
  }
}

async function healthCheckContainer(
  host: string,
  user: string,
  containerName: string,
  retries: number = 5
): Promise<boolean> {
  // Sanitize inputs to prevent CLI injection
  const safeUser = sanitizeSSHUser(user)
  const safeHost = sanitizeSSHHost(host)
  const sshTarget = `${safeUser}@${safeHost}`

  const s = spinner()
  s.start(`Health checking container ${containerName}`)

  try {
    // Wait a bit for container to start
    await new Promise(resolve => setTimeout(resolve, 2000))

    for (let i = 0; i < retries; i++) {
      const result = await execa(
        'ssh',
        [
          '-o',
          'StrictHostKeyChecking=accept-new',
          '-o',
          'ConnectTimeout=10',
          sshTarget,
          `docker inspect --format='{{.State.Status}}' ${containerName}`,
        ],
        { reject: false }
      )

      if (result.stdout.trim() === 'running') {
        // Additional check: ensure container hasn't restarted
        const restartCount = await execa(
          'ssh',
          [
            '-o',
            'StrictHostKeyChecking=accept-new',
            '-o',
            'ConnectTimeout=10',
            sshTarget,
            `docker inspect --format='{{.RestartCount}}' ${containerName}`,
          ],
          { reject: false }
        )

        if (restartCount.stdout.trim() === '0') {
          s.stop('✓ Container is healthy')
          return true
        }
      }

      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    s.stop('✗ Container health check failed')
    return false
  } catch (error) {
    s.stop('✗ Health check failed')
    return false
  }
}

async function runImageOnTarget(
  host: string,
  user: string,
  image: string,
  ports: string,
  envVars: string
) {
  // Sanitize inputs to prevent CLI injection
  const safeUser = sanitizeSSHUser(user)
  const safeHost = sanitizeSSHHost(host)
  const sshTarget = `${safeUser}@${safeHost}`

  let s = spinner()
  s.start('Checking for existing deployment on port')

  try {
    // Check if any container is using the target port
    const portMapping = parsePortMapping(ports)
    let existingContainer = null

    if (portMapping) {
      existingContainer = await findContainerByPort(
        host,
        user,
        portMapping.hostPort
      )
    }

    if (existingContainer && portMapping) {
      s.stop(`✓ Found container using port ${portMapping.hostPort}`)

      // Display container details
      note(
        `Name: ${existingContainer.name}\n` +
          `Image: ${existingContainer.image}\n` +
          `Status: ${existingContainer.status}\n` +
          `ID: ${existingContainer.id}`,
        'Existing Container Details'
      )

      // Ask user if they want to replace it
      const shouldReplace = await confirm({
        message: `Replace this container with the new image (${image})?`,
      })

      if (isCancel(shouldReplace) || !shouldReplace) {
        cancel('Deployment cancelled')
        process.exit(0)
      }

      // Blue-green deployment: start staging container
      const containerName = generateContainerName(image)
      const stagingName = `${containerName}-staging`
      const stagingPort = `${
        parseInt(portMapping.hostPort) + 10000
      }:${portMapping.containerPort}`

      s = spinner()
      s.start(`Starting staging container on port ${stagingPort}`)

      const stagingPortArgs = `-p ${stagingPort}`
      const envArgs = envVars ? `-e ${envVars}` : ''
      const runStagingCmd =
        `docker run -d --name ${stagingName} ${stagingPortArgs} ${envArgs} ${image}`.trim()

      await execa('ssh', [
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=10',
        sshTarget,
        runStagingCmd,
      ])

      s.stop('✓ Staging container started')

      // Health check staging container
      const isHealthy = await healthCheckContainer(host, user, stagingName)

      if (!isHealthy) {
        // Cleanup failed staging container
        await execa(
          'ssh',
          [
            '-o',
            'StrictHostKeyChecking=accept-new',
            '-o',
            'ConnectTimeout=10',
            sshTarget,
            `docker rm -f ${stagingName}`,
          ],
          { reject: false }
        )
        throw new Error('Staging container failed health check')
      }

      // Stop and remove old container
      s = spinner()
      s.start(`Stopping container ${existingContainer.name}`)

      await execa('ssh', [
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=10',
        sshTarget,
        `docker stop ${existingContainer.name}`,
      ])

      await execa('ssh', [
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=10',
        sshTarget,
        `docker rm ${existingContainer.name}`,
      ])

      s.stop('✓ Old container stopped and removed')

      // Start new container with production ports
      s = spinner()
      s.start('Starting new production container')

      const portArgs = `-p ${ports}`
      const runProdCmd =
        `docker run -d --name ${containerName} ${portArgs} ${envArgs} ${image}`.trim()

      await execa('ssh', [
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=10',
        sshTarget,
        runProdCmd,
      ])

      s.stop('✓ Production container started')

      // Cleanup staging container
      await execa(
        'ssh',
        [
          '-o',
          'StrictHostKeyChecking=accept-new',
          '-o',
          'ConnectTimeout=10',
          sshTarget,
          `docker rm -f ${stagingName}`,
        ],
        { reject: false }
      )

      s = spinner()
      s.start('Blue-green deployment complete')
      s.stop('✓ Deployment successful with zero-downtime switchover')
    } else {
      s.stop(
        ports
          ? `✓ No container found on port ${portMapping?.hostPort}`
          : '✓ Starting first deployment'
      )

      // First deployment: start container normally
      const containerName = generateContainerName(image)
      s = spinner()
      s.start(`Starting container ${containerName}`)

      const portArgs = ports ? `-p ${ports}` : ''
      const envArgs = envVars ? `-e ${envVars}` : ''
      const runCmd =
        `docker run -d --name ${containerName} ${portArgs} ${envArgs} ${image}`.trim()

      await execa('ssh', [
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=10',
        sshTarget,
        runCmd,
      ])

      s.stop('✓ Container started successfully')

      // Health check the new container
      const isHealthy = await healthCheckContainer(host, user, containerName)

      if (!isHealthy) {
        // Cleanup failed container
        await execa(
          'ssh',
          [
            '-o',
            'StrictHostKeyChecking=accept-new',
            '-o',
            'ConnectTimeout=10',
            sshTarget,
            `docker rm -f ${containerName}`,
          ],
          { reject: false }
        )
        throw new Error('Container failed health check')
      }
    }
  } catch (error) {
    s.stop('✗ Deployment failed')
    throw error
  }
}

async function main() {
  console.clear()

  const command = process.argv[2]

  // Handle version flag
  if (command === '-v' || command === '--version') {
    console.log(`v${pkg.version}`)
    process.exit(0)
  }

  if (!command || !['setup', 'deploy'].includes(command)) {
    intro('🚀 Zeus - Docker Build Server')
    note(
      'zeus setup   - Setup Docker on SSH target\n' +
        'zeus deploy  - Deploy application (build + transfer + run)',
      'Available Commands'
    )
    outro('Usage: zeus <command>')
    process.exit(1)
  }

  intro('🚀 Zeus - Docker Build Server')

  try {
    if (command === 'setup') {
      // Try to load configuration from .zeusrc
      const config = await loadConfig()

      let host: string
      let user: string

      if (config) {
        // Validate host and user from config
        try {
          host = sanitizeSSHHost(config.host)
          user = sanitizeSSHUser(config.user)
        } catch (error) {
          outro('✗ Invalid configuration in .zeusrc')
          console.error(error instanceof Error ? error.message : String(error))
          process.exit(1)
        }

        note(
          `Host: ${host}\n` + `User: ${user}`,
          'Using configuration from .zeusrc'
        )
      } else {
        // Prompt for host and user
        note(
          'No .zeusrc file found. You can create one to save these settings.\n' +
            'See .zeusrc.example for a template.',
          'Configuration file not found'
        )

        const hostInput = await text({
          message: 'SSH host:',
          placeholder: 'example.com',
          validate: value => {
            if (!value) return 'Host is required'
            try {
              sanitizeSSHHost(value)
            } catch (error) {
              return error instanceof Error
                ? error.message
                : 'Invalid host format'
            }
          },
        })

        if (isCancel(hostInput)) {
          cancel('Operation cancelled')
          process.exit(0)
        }

        const userInput = await text({
          message: 'SSH user:',
          placeholder: 'ubuntu',
          validate: value => {
            if (!value) return 'User is required'
            try {
              sanitizeSSHUser(value)
            } catch (error) {
              return error instanceof Error
                ? error.message
                : 'Invalid user format'
            }
          },
        })

        if (isCancel(userInput)) {
          cancel('Operation cancelled')
          process.exit(0)
        }

        host = hostInput as string
        user = userInput as string
      }

      await setupSSHTarget(host, user)
    } else if (command === 'deploy') {
      // Load configuration from .zeusrc
      let config = await loadConfig()

      // Check if running in CI environment
      const isCI = process.env.CI === 'true' || process.env.CI === '1'

      if (!config) {
        if (isCI) {
          // In CI, .zeusrc must exist
          outro('✗ CI environment detected but .zeusrc file not found')
          console.error(
            'Error: .zeusrc configuration file is required in CI environments'
          )
          console.error(
            'Please create a .zeusrc file with your deployment configuration'
          )
          process.exit(1)
        }

        note(
          'No .zeusrc file found. You can create one to save these settings.\n' +
            'See .zeusrc.example for a template.',
          'Configuration file not found'
        )

        // Prompt for all deployment settings
        const host = await text({
          message: 'SSH host:',
          placeholder: 'example.com',
          validate: value => {
            if (!value) return 'Host is required'
            try {
              sanitizeSSHHost(value)
            } catch (error) {
              return error instanceof Error
                ? error.message
                : 'Invalid host format'
            }
          },
        })

        if (isCancel(host)) {
          cancel('Operation cancelled')
          process.exit(0)
        }

        const user = await text({
          message: 'SSH user:',
          placeholder: 'ubuntu',
          validate: value => {
            if (!value) return 'User is required'
            try {
              sanitizeSSHUser(value)
            } catch (error) {
              return error instanceof Error
                ? error.message
                : 'Invalid user format'
            }
          },
        })

        if (isCancel(user)) {
          cancel('Operation cancelled')
          process.exit(0)
        }

        const dockerfile = await text({
          message: 'Path to Dockerfile:',
          placeholder: './Dockerfile',
          initialValue: './Dockerfile',
        })

        if (isCancel(dockerfile)) {
          cancel('Operation cancelled')
          process.exit(0)
        }

        const platform = await select({
          message: 'Target platform:',
          options: [
            { value: 'linux/amd64', label: 'Linux AMD64 (x86_64)' },
            { value: 'linux/arm64', label: 'Linux ARM64' },
            { value: 'linux/arm/v7', label: 'Linux ARM v7' },
          ],
        })

        if (isCancel(platform)) {
          cancel('Operation cancelled')
          process.exit(0)
        }

        const image = await text({
          message: 'Image name:',
          placeholder: 'my-app:latest',
          validate: value => {
            if (!value) return 'Image name is required'
          },
        })

        if (isCancel(image)) {
          cancel('Operation cancelled')
          process.exit(0)
        }

        const ports = await text({
          message: 'Port mapping (optional):',
          placeholder: '8080:80',
        })

        if (isCancel(ports)) {
          cancel('Operation cancelled')
          process.exit(0)
        }

        const env = await text({
          message: 'Environment variables (optional):',
          placeholder: 'NODE_ENV=production',
        })

        if (isCancel(env)) {
          cancel('Operation cancelled')
          process.exit(0)
        }

        // Build config from prompted values
        config = {
          host: host as string,
          user: user as string,
          dockerfile: dockerfile as string,
          platform: platform as string,
          image: image as string,
          ports: ports as string,
          env: env as string,
        }
      }

      // Validate host and user from config (whether from .zeusrc or prompts)
      try {
        sanitizeSSHHost(config.host)
        sanitizeSSHUser(config.user)
      } catch (error) {
        outro('✗ Invalid SSH host or user in configuration')
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }

      // Display configuration
      note(
        `Host: ${config.host}\n` +
          `User: ${config.user}\n` +
          `Dockerfile: ${config.dockerfile || './Dockerfile'}\n` +
          `Platform: ${config.platform || 'linux/amd64'}\n` +
          `Image: ${config.image}\n` +
          `Ports: ${config.ports || 'none'}\n` +
          `Env: ${config.env || 'none'}`,
        'Deployment Configuration'
      )

      const shouldContinue = await confirm({
        message: 'Continue with deployment?',
      })

      if (isCancel(shouldContinue) || !shouldContinue) {
        cancel('Deployment cancelled')
        process.exit(0)
      }

      // Execute full deployment
      await buildDockerImage(
        config.dockerfile || './Dockerfile',
        config.platform || 'linux/amd64',
        config.image
      )

      await transferAndLoadImage(config.host, config.user, config.image)

      await runImageOnTarget(
        config.host,
        config.user,
        config.image,
        config.ports || '',
        config.env || ''
      )
    }

    outro('✓ All done!')
  } catch (error) {
    outro('✗ Operation failed')
    console.error(error)
    process.exit(1)
  }
}

main().catch(console.error)
