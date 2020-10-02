/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { getVoidLogger, UrlReader } from '@backstage/backend-common';
import {
  Entity,
  EntityPolicies,
  EntityPolicy,
  ENTITY_DEFAULT_NAMESPACE,
  LocationSpec,
} from '@backstage/catalog-model';
import { Config, ConfigReader } from '@backstage/config';
import { Logger } from 'winston';
import { CatalogRulesEnforcer } from './CatalogRules';
import { AnnotateLocationEntityProcessor } from './processors/AnnotateLocationEntityProcessor';
import { ApiDefinitionAtLocationProcessor } from './processors/ApiDefinitionAtLocationProcessor';
import { AzureApiReaderProcessor } from './processors/AzureApiReaderProcessor';
import { BitbucketApiReaderProcessor } from './processors/BitbucketApiReaderProcessor';
import { EntityPolicyProcessor } from './processors/EntityPolicyProcessor';
import { FileReaderProcessor } from './processors/FileReaderProcessor';
import { GithubOrgReaderProcessor } from './processors/GithubOrgReaderProcessor';
import { GitlabApiReaderProcessor } from './processors/GitlabApiReaderProcessor';
import { GitlabReaderProcessor } from './processors/GitlabReaderProcessor';
import { LocationRefProcessor } from './processors/LocationEntityProcessor';
import { PlaceholderProcessor } from './processors/PlaceholderProcessor';
import { CodeOwnersProcessor } from './processors/CodeOwnersProcessor';
import * as result from './processors/results';
import { StaticLocationProcessor } from './processors/StaticLocationProcessor';
import {
  LocationProcessor,
  LocationProcessorDataResult,
  LocationProcessorEmit,
  LocationProcessorEntityResult,
  LocationProcessorErrorResult,
  LocationProcessorLocationResult,
  LocationProcessorResult,
} from './processors/types';
import { UrlReaderProcessor } from './processors/UrlReaderProcessor';
import { YamlProcessor } from './processors/YamlProcessor';
import { LocationReader, ReadLocationResult } from './types';

// The max amount of nesting depth of generated work items
const MAX_DEPTH = 10;

type Options = {
  reader?: UrlReader;
  logger?: Logger;
  config?: Config;
  processors?: LocationProcessor[];
};

/**
 * Implements the reading of a location through a series of processor tasks.
 */
export class LocationReaders implements LocationReader {
  private readonly logger: Logger;
  private readonly processors: LocationProcessor[];
  private readonly rulesEnforcer: CatalogRulesEnforcer;

  static defaultProcessors(options: {
    logger: Logger;
    reader?: UrlReader;
    config?: Config;
    entityPolicy?: EntityPolicy;
  }): LocationProcessor[] {
    const {
      config = new ConfigReader({}, 'missing-config'),
      entityPolicy = new EntityPolicies(),
    } = options;
    return [
      StaticLocationProcessor.fromConfig(config),
      new FileReaderProcessor(),
      new GitlabApiReaderProcessor(config),
      new GitlabReaderProcessor(),
      new BitbucketApiReaderProcessor(config),
      new AzureApiReaderProcessor(config),
      GithubOrgReaderProcessor.fromConfig(config),
      options.reader
        ? new UrlReaderProcessor({
            reader: options.reader,
            logger: options.logger,
          })
        : [],
      new YamlProcessor(),
      PlaceholderProcessor.default(),
      new CodeOwnersProcessor(),
      new ApiDefinitionAtLocationProcessor(),
      new EntityPolicyProcessor(entityPolicy),
      new LocationRefProcessor(),
      new AnnotateLocationEntityProcessor(),
    ].flat();
  }

  constructor({
    logger = getVoidLogger(),
    config,
    reader,
    processors = LocationReaders.defaultProcessors({ logger, reader, config }),
  }: Options) {
    this.logger = logger;
    this.processors = processors;
    this.rulesEnforcer = config
      ? CatalogRulesEnforcer.fromConfig(config)
      : new CatalogRulesEnforcer(CatalogRulesEnforcer.defaultRules);
  }

  async read(location: LocationSpec): Promise<ReadLocationResult> {
    const output: ReadLocationResult = { entities: [], errors: [] };
    let items: LocationProcessorResult[] = [result.location(location, false)];

    for (let depth = 0; depth < MAX_DEPTH; ++depth) {
      const newItems: LocationProcessorResult[] = [];
      const emit: LocationProcessorEmit = i => newItems.push(i);

      for (const item of items) {
        if (item.type === 'location') {
          await this.handleLocation(item, emit);
        } else if (item.type === 'data') {
          await this.handleData(item, emit);
        } else if (item.type === 'entity') {
          if (this.rulesEnforcer.isAllowed(item.entity, item.location)) {
            const entity = await this.handleEntity(item, emit);
            output.entities.push({
              entity,
              location: item.location,
            });
          } else {
            output.errors.push({
              location: item.location,
              error: new Error(
                `Entity of kind ${item.entity.kind} is not allowed from location ${item.location.target}:${item.location.type}`,
              ),
            });
          }
        } else if (item.type === 'error') {
          await this.handleError(item, emit);
          output.errors.push({
            location: item.location,
            error: item.error,
          });
        }
      }

      if (newItems.length === 0) {
        return output;
      }

      items = newItems;
    }

    const message = `Max recursion depth ${MAX_DEPTH} reached for ${location.type} ${location.target}`;
    this.logger.warn(message);
    output.errors.push({ location, error: new Error(message) });
    return output;
  }

  private async handleLocation(
    item: LocationProcessorLocationResult,
    emit: LocationProcessorEmit,
  ) {
    this.logger.debug(
      `Reading location ${item.location.type} ${item.location.target} optional=${item.optional}`,
    );

    for (const processor of this.processors) {
      if (processor.readLocation) {
        try {
          if (
            await processor.readLocation(item.location, item.optional, emit)
          ) {
            return;
          }
        } catch (e) {
          const message = `Processor ${processor.constructor.name} threw an error while reading location ${item.location.type} ${item.location.target}, ${e}`;
          emit(result.generalError(item.location, message));
          this.logger.warn(message);
        }
      }
    }

    const message = `No processor was able to read location ${item.location.type} ${item.location.target}`;
    emit(result.inputError(item.location, message));
    this.logger.warn(message);
  }

  private async handleData(
    item: LocationProcessorDataResult,
    emit: LocationProcessorEmit,
  ) {
    this.logger.debug(
      `Parsing data from location ${item.location.type} ${item.location.target} (${item.data.byteLength} bytes)`,
    );

    for (const processor of this.processors) {
      if (processor.parseData) {
        try {
          if (await processor.parseData(item.data, item.location, emit)) {
            return;
          }
        } catch (e) {
          const message = `Processor ${processor.constructor.name} threw an error while parsing ${item.location.type} ${item.location.target}, ${e}`;
          emit(result.generalError(item.location, message));
          this.logger.warn(message);
        }
      }
    }

    const message = `No processor was able to parse location ${item.location.type} ${item.location.target}`;
    emit(result.inputError(item.location, message));
  }

  private async handleEntity(
    item: LocationProcessorEntityResult,
    emit: LocationProcessorEmit,
  ): Promise<Entity> {
    this.logger.debug(
      `Got entity at location ${item.location.type} ${item.location.target}, ${item.entity.apiVersion} ${item.entity.kind}`,
    );

    let current = item.entity;

    for (const processor of this.processors) {
      if (processor.processEntity) {
        try {
          current = await processor.processEntity(
            current,
            item.location,
            emit,
            this.readLocation.bind(this),
          );
        } catch (e) {
          // Construct the name carefully, if we got validation errors we do
          // not want to crash here due to missing metadata or so
          const namespace = !current.metadata
            ? ''
            : current.metadata.namespace ?? ENTITY_DEFAULT_NAMESPACE;
          const name = !current.metadata ? '' : current.metadata.name;
          const message = `Processor ${processor.constructor.name} threw an error while processing entity ${current.kind}:${namespace}/${name} at ${item.location.type} ${item.location.target}, ${e}`;
          emit(result.generalError(item.location, message));
          this.logger.warn(message);
        }
      }
    }

    return current;
  }

  private async handleError(
    item: LocationProcessorErrorResult,
    emit: LocationProcessorEmit,
  ) {
    this.logger.debug(
      `Encountered error at location ${item.location.type} ${item.location.target}, ${item.error}`,
    );

    for (const processor of this.processors) {
      if (processor.handleError) {
        try {
          await processor.handleError(item.error, item.location, emit);
        } catch (e) {
          const message = `Processor ${processor.constructor.name} threw an error while handling another error at ${item.location.type} ${item.location.target}, ${e}`;
          emit(result.generalError(item.location, message));
          this.logger.warn(message);
        }
      }
    }
  }

  private async readLocation(location: LocationSpec): Promise<Buffer> {
    let data: Buffer | undefined = undefined;
    let error: Error | undefined = undefined;

    await this.handleLocation(
      {
        type: 'location',
        location,
        optional: false,
      },
      output => {
        if (output.type === 'error' && !error) {
          error = output.error;
        } else if (output.type === 'data') {
          if (data) {
            if (!error) {
              error = new Error(
                'More than one piece of data loaded unexpectedly',
              );
            }
          } else {
            data = output.data;
          }
        }
      },
    );

    if (error) {
      throw error;
    } else if (!data) {
      throw new Error('No data loaded');
    }

    return data;
  }
}
