---
id: installation
title: Installing in your Backstage App
description: Documentation on How to install Backstage App
---

The scaffolder plugin comes in two packages, `@backstage/plugin-scaffolder` and
`@backstage/plugin-scaffolder-backend`. Each has their own installation steps,
outlined below.

The Scaffolder plugin also depends on the Software Catalog. Instructions for how
to set that up can be found [here](../software-catalog/installation.md).

## Installing @backstage/plugin-scaffolder

> **Note that if you used `npx @backstage/create-app`, the plugin may already be
> present**

The scaffolder frontend plugin should be installed in your `app` package, which
is created as a part of `@backstage/create-app`. To install the package, run:

```bash
cd packages/app
yarn add @backstage/plugin-scaffolder
```

Make sure the version of `@backstage/plugin-scaffolder` matches the version of
other `@backstage` packages. You can update it in `packages/app/package.json` if
it doesn't.

### Adding the Plugin to your `packages/app`

Add the following entry to the head of your `packages/app/src/plugins.ts`:

```ts
export { plugin as ScaffolderPlugin } from '@backstage/plugin-scaffolder';
```

Add the following to your `packages/app/src/apis.ts`:

```ts
import { scaffolderApiRef, ScaffolderApi } from '@backstage/plugin-scaffolder';

// Inside the ApiRegistry builder function ...

builder.add(
  scaffolderApiRef,
  new ScaffolderApi({
    apiOrigin: backendUrl,
    basePath: '/scaffolder/v1',
  }),
);
```

Where `backendUrl` is the `backend.baseUrl` from config, i.e.
`const backendUrl = config.getString('backend.baseUrl')`.

This is all that is needed for the frontend part of the Scaffolder plugin to
work!

## Installing @backstage/plugin-scaffolder-backend

> **Note that if you used `npx @backstage/create-app`, the plugin may already be
> present**

The scaffolder backend should be installed in your `backend` package, which is
created as a part of `@backstage/create-app`. To install the package, run:

```bash
cd packages/backend
yarn add @backstage/plugin-scaffolder-backend
```

Make sure the version of `@backstage/plugin-scaffolder-backend` matches the
version of other `@backstage` packages. You can update it in
`packages/backend/package.json` if it doesn't.

### Adding the Plugin to your `packages/backend`

You'll need to add the plugin to the `backend`'s router. You can do this by
creating a file called `packages/backend/src/plugins/scaffolder.ts` with the
following contents to get you up and running quickly.

```ts
import {
  CookieCutter,
  createRouter,
  FilePreparer,
  GithubPreparer,
  GitlabPreparer,
  Preparers,
  Publishers,
  GithubPublisher,
  GitlabPublisher,
  CreateReactAppTemplater,
  Templaters,
  RepoVisibilityOptions,
} from '@backstage/plugin-scaffolder-backend';
import { Octokit } from '@octokit/rest';
import { Gitlab } from '@gitbeaker/node';
import type { PluginEnvironment } from '../types';
import Docker from 'dockerode';

export default async function createPlugin({
  logger,
  config,
}: PluginEnvironment) {
  const cookiecutterTemplater = new CookieCutter();
  const craTemplater = new CreateReactAppTemplater();
  const templaters = new Templaters();
  templaters.register('cookiecutter', cookiecutterTemplater);
  templaters.register('cra', craTemplater);

  const filePreparer = new FilePreparer();
  const githubPreparer = new GithubPreparer();
  const gitlabPreparer = new GitlabPreparer(config);
  const preparers = new Preparers();

  preparers.register('file', filePreparer);
  preparers.register('github', githubPreparer);
  preparers.register('gitlab', gitlabPreparer);
  preparers.register('gitlab/api', gitlabPreparer);

  const publishers = new Publishers();

  const githubToken = config.getString('scaffolder.github.token');
  const repoVisibility = config.getString(
    'scaffolder.github.visibility',
  ) as RepoVisibilityOptions;

  const githubClient = new Octokit({ auth: githubToken });
  const githubPublisher = new GithubPublisher({
    client: githubClient,
    token: githubToken,
    repoVisibility,
  });
  publishers.register('file', githubPublisher);
  publishers.register('github', githubPublisher);

  const gitLabConfig = config.getOptionalConfig('scaffolder.gitlab.api');

  if (gitLabConfig) {
    const gitLabToken = gitLabConfig.getString('token');
    const gitLabClient = new Gitlab({
      host: gitLabConfig.getOptionalString('baseUrl'),
      token: gitLabToken,
    });
    const gitLabPublisher = new GitlabPublisher(gitLabClient, gitLabToken);
    publishers.register('gitlab', gitLabPublisher);
    publishers.register('gitlab/api', gitLabPublisher);
  }

  const dockerClient = new Docker();
  return await createRouter({
    preparers,
    templaters,
    publishers,
    logger,
    dockerClient,
  });
}
```

Once the `scaffolder.ts` router setup file is in place, add the router to
`packages/backend/src/index.ts`:

```ts
import scaffolder from './plugins/scaffolder';

const scaffolderEnv = useHotMemoize(module, () => createEnv('scaffolder'));

const service = createServiceBuilder(module)
  .loadConfig(configReader)
  /** several different routers */
  .addRouter('/scaffolder', await scaffolder(scaffolderEnv));
```

### Adding Templates

At this point the scaffolder backend is installed in your backend package, but
you will not have any templates available to use. These need to be added to the
software catalog, as they are represented as entities of kind
[Template](../software-catalog/descriptor-format.md#kind-template). You can find
out more about adding templates [here](./adding-templates.md).

To get up and running and try out some templates quickly, you can add some of
our example templates through static configuration. Add the following to the
`catalog.locations` section in your `app-config.yaml`:

```yaml
catalog:
  locations:
    # Backstage Example Templates
    - type: url
      target: https://github.com/spotify/backstage/blob/master/plugins/scaffolder-backend/sample-templates/react-ssr-template/template.yaml
    - type: url
      target: https://github.com/spotify/backstage/blob/master/plugins/scaffolder-backend/sample-templates/springboot-grpc-template/template.yaml
    - type: url
      target: https://github.com/spotify/backstage/blob/master/plugins/scaffolder-backend/sample-templates/create-react-app/template.yaml
    - type: url
      target: https://github.com/spotify/cookiecutter-golang/blob/master/template.yaml
```

### Runtime Dependencies / Configuration

For the scaffolder backend plugin to function, it needs a GitHub access token,
and access to a running Docker daemon. You can create a GitHub access token
[here](https://github.com/settings/tokens/new), select `repo` scope only. Full
docs on creating private GitHub access tokens is available
[here](https://docs.github.com/en/github/authenticating-to-github/creating-a-personal-access-token).
Note that the need for private GitHub access tokens will be replaced with GitHub
Apps integration further down the line.

#### Github

The Github access token is retrieved from environment variables via the config.
The config file needs to specify what environment variable the token is
retrieved from. Your config should have the following objects.

You can configure who can see the new repositories that the scaffolder creates
by specifying `visibility` option. Valid options are `public`, `private` and
`internal`. `internal` options is for GitHub Enterprise clients, which means
public within the organization.

#### Gitlab

For Gitlab, we currently support the configuration of the GitLab publisher and
allows to configure the private access token and the base URL of a GitLab
instance:

```yaml
scaffolder:
  github:
    token:
      $secret:
        env: GITHUB_ACCESS_TOKEN
    visibility: public # or 'internal' or 'private'
  gitlab:
    api:
      baseUrl: https://gitlab.com
      token:
        $secret:
          env: SCAFFOLDER_GITLAB_PRIVATE_TOKEN
```

#### Azure DevOps

For Azure DevOps we support both the preparer and publisher stage with the
configuration of a private access token (PAT). For the publisher it's also
required to define the base URL for the client to connect to the service. This
will hopefully support on-prem installations as well but that has not been
verified.

```yaml
scaffolder:
  azure:
    baseUrl: https://dev.azure.com/{your-organization}
    api:
      token:
        $secret:
          env: AZURE_PRIVATE_TOKEN
```

### Running the Backend

Finally, make sure you have a local Docker daemon running, and start up the
backend with the new configuration:

```bash
cd packages/backend
GITHUB_ACCESS_TOKEN=<token> yarn start
```

If you've also set up the frontend plugin, so you should be ready to go browse
the templates at [localhost:3000/create](http://localhost:3000/create) now!
