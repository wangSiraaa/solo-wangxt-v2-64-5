import { Injectable } from '@nestjs/common';
import { DeliveryChannel, ReceiptEvent } from '../common/enums';

export interface DispatchResult {
  /** 渠道是否已受理（仅证明“已发送”，不代表送达） */
  accepted: boolean;
  /** 模拟同步给出的终态事件；离线异步场景为 null，等待投递器回传 */
  terminalEvent: ReceiptEvent.DELIVERED | ReceiptEvent.FAILED | null;
  failureReason: string | null;
  channel: DeliveryChannel;
}

/**
 * 家属告知多渠道投递器（离线模拟桩，不连接真实短信或外部服务）。
 *
 * 两种模拟模式：
 *  - asyncMode=true：仅受理（accepted=true, terminalEvent=null），
 *    送达/失败由测试或“离线投递器”通过回执 API 异步回传（可重复、乱序、迟到）；
 *  - asyncMode=false（默认，兼容历史行为）：受理后同步给出确定的送达/失败，
 *    服务端仍以“回执归并”的同一状态机落库，“已发送”从不被当作“已确认”。
 * 渠道按联系方式后缀/显式参数模拟失败，例如号码以 -FAIL 结尾。
 */
@Injectable()
export class NotifyChannelService {
  async dispatch(params: {
    familyContact: string;
    message: string;
    forceFail?: boolean;
    channel?: DeliveryChannel;
    asyncMode?: boolean;
  }): Promise<DispatchResult> {
    const {
      familyContact,
      forceFail = false,
      channel = DeliveryChannel.SMS,
      asyncMode = false,
    } = params;
    // 保留历史签名需要的微小延迟，模拟投递器网络往返
    await new Promise((r) => setTimeout(r, 5));

    const fails =
      forceFail === true || familyContact.endsWith('-FAIL');
    if (fails) {
      // 即使通道失败也先视为“未受理”，由调用方落 FAILED 终态
      return {
        accepted: false,
        terminalEvent: ReceiptEvent.FAILED,
        failureReason: forceFail
          ? '模拟通道异常：网关超时'
          : '通道返回：家属号码无效',
        channel,
      };
    }

    if (asyncMode) {
      // 已发送/已受理 ≠ 已送达：最终状态等待异步回执
      return {
        accepted: true,
        terminalEvent: null,
        failureReason: null,
        channel,
      };
    }

    return {
      accepted: true,
      terminalEvent: ReceiptEvent.DELIVERED,
      failureReason: null,
      channel,
    };
  }

  /** 历史调用签名兼容（同步模拟送达结果） */
  async send(
    familyContact: string,
    message: string,
    forceFail: boolean,
  ): Promise<{ delivered: boolean; failureReason: string | null }> {
    const r = await this.dispatch({ familyContact, message, forceFail });
    return {
      delivered: r.terminalEvent === ReceiptEvent.DELIVERED,
      failureReason: r.failureReason,
    };
  }
}
