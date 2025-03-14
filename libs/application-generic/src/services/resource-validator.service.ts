import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CommunityOrganizationRepository,
  EnvironmentEntity,
  EnvironmentRepository,
  NotificationTemplateRepository,
  OrganizationEntity,
} from '@novu/dal';
import { ApiServiceLevelEnum, FeatureFlagsKeysEnum, FeatureNameEnum, getFeatureForTierAsNumber } from '@novu/shared';

import { NotificationStep } from '../usecases';
import { FeatureFlagsService } from './feature-flags';

export const DAY_IN_MS = 24 * 60 * 60 * 1000;

/* The absolute maximum values allowed by the system */
export const SYSTEM_LIMITS = {
  WORKFLOWS: 100,
  STEPS_PER_WORKFLOW: 20,
  DEFER_DURATION_MS: 180 * DAY_IN_MS,
} as const;

/* The threshold below which validation is skipped */
export const MIN_VALIDATION_LIMITS = {
  WORKFLOWS: 20,
  STEPS_PER_WORKFLOW: 20,
  DEFER_DURATION_MS: DAY_IN_MS,
} as const;

@Injectable()
export class ResourceValidatorService {
  constructor(
    private notificationTemplateRepository: NotificationTemplateRepository,
    private organizationRepository: CommunityOrganizationRepository,
    private environmentRepository: EnvironmentRepository,
    private featureFlagService: FeatureFlagsService
  ) {}

  async validateStepsLimit(environmentId: string, organizationId: string, steps: NotificationStep[]): Promise<void> {
    if (steps.length < MIN_VALIDATION_LIMITS.STEPS_PER_WORKFLOW) {
      return;
    }

    const organization = await this.getOrganization(organizationId);

    const maxStepsPerWorkflowNumber = await this.featureFlagService.getFlag({
      key: FeatureFlagsKeysEnum.MAX_STEPS_PER_WORKFLOW_LIMIT_NUMBER,
      environment: { _id: environmentId },
      organization,
      defaultValue: SYSTEM_LIMITS.STEPS_PER_WORKFLOW,
    });

    if (steps.length > maxStepsPerWorkflowNumber) {
      throw new BadRequestException({
        message: `Workflow steps limit exceeded. Maximum allowed steps is ${maxStepsPerWorkflowNumber}, but got ${steps.length} steps.`,
        providedStepsCount: steps.length,
        maxSteps: maxStepsPerWorkflowNumber,
      });
    }
  }

  async validateWorkflowLimit(environmentId: string): Promise<void> {
    const workflowsCount = await this.notificationTemplateRepository.count({
      _environmentId: environmentId,
    });

    if (workflowsCount < MIN_VALIDATION_LIMITS.WORKFLOWS) {
      return;
    }

    const environment = await this.getEnvironment(environmentId);
    const organization = await this.getOrganization(environment._organizationId);
    const maxWorkflowLimit = await this.getWorkflowLimit(environment, organization);

    if (workflowsCount >= maxWorkflowLimit) {
      throw new BadRequestException({
        message: 'Workflow limit exceeded. Please contact us to support more workflows.',
        currentCount: workflowsCount,
        limit: maxWorkflowLimit,
      });
    }
  }

  private async getWorkflowLimit(environment: EnvironmentEntity, organization: OrganizationEntity) {
    const systemLimitMaxWorkflow = await this.getMaxWorkflowSystemLimit(environment, organization);

    // If the system limit is not the default, we need to use it as the absolute limit for special cases instead of the tier limit
    const isSpecialLimit = systemLimitMaxWorkflow !== SYSTEM_LIMITS.WORKFLOWS;
    if (isSpecialLimit) {
      return systemLimitMaxWorkflow;
    }

    const maxWorkflowsTierLimit = await this.getMaxWorkflowsTierLimit(environment, organization);

    return Math.min(systemLimitMaxWorkflow, maxWorkflowsTierLimit);
  }

  private async getMaxWorkflowsTierLimit(environment, organization) {
    return getFeatureForTierAsNumber(
      FeatureNameEnum.PLATFORM_MAX_WORKFLOWS,
      organization.apiServiceLevel || ApiServiceLevelEnum.FREE,
      false
    );
  }

  private async getMaxWorkflowSystemLimit(environment, organization) {
    return await this.featureFlagService.getFlag({
      key: FeatureFlagsKeysEnum.MAX_WORKFLOW_LIMIT_NUMBER,
      defaultValue: SYSTEM_LIMITS.WORKFLOWS,
      environment,
      organization,
    });
  }

  private async getEnvironment(environmentId: string) {
    const environment = await this.environmentRepository.findOne({ _id: environmentId });

    if (!environment) {
      throw new BadRequestException({
        message: 'Environment not found',
      });
    }

    return environment;
  }

  private async getOrganization(organizationId: string) {
    const organization = await this.organizationRepository.findById(organizationId);

    if (!organization) {
      throw new BadRequestException({
        message: 'Organization not found',
      });
    }

    return organization;
  }
}
