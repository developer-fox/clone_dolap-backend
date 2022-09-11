


const express = require("express");
const { isValidObjectId } = require("mongoose");
const user_model = require("../model/mongoose_models/user_model");
const sold_notice_model = require("../model/mongoose_models/sold_notice_model");
const router = express.Router();
const uuid = require("uuid");
const sold_notice_states = require("../model/data_helper_models/saled_notice_states");
const notice_states = require("../model/data_helper_models/notice_states");
const { sendJsonWithTokens } = require("../services/response_sendjson");
const notice_model = require("../model/mongoose_models/notice_model");
const mailServices = require("../services/mail_services");
const timeoutService = require("../services/timeout_services");
const socketManager = require("../services/socket_manager");
const socketServices = require("../services/socket_services")(socketManager.getIo());
const notification_types = require("../model/data_helper_models/notification_types");
const notificationModel = require("../model/data_helper_models/notification_model");

router.post('/check_cart', async(req, res, next)=>{
  const address_id = req.body.address_id;
  if(!address_id) return next(new Error("address id cannot be empty"));
  if(!isValidObjectId(address_id)) return next(new Error("invalid address id"));
  try {
	  const currentUser = await user_model.findById(req.decoded.id).select("cart addresses user_coupons username email").populate("cart.items.notice");

    if(!currentUser) return next(new Error("user not found"));
    const address =currentUser.addresses.id(address_id);
    if(!address) return next(new Error("address not found"));
    if(currentUser.cart.items.length==0) return next(new Error("the cart is empty"));
    const currentTime = new Date();
    for await (let saled_notice of currentUser.cart.items){
      let total_amount = 0;
      const currentNotice = saled_notice.notice;
      const currentSaler = await user_model.findById(currentNotice.saler_user).select("username email sold_notices_count");
      const payment_details = [
        {
          payment_amount: saled_notice.total_price,
          payment_title: "ürün fiyatı"
        },  
        ...currentUser.cart.details.map(detail =>{
          if(detail.detail_id == saled_notice.notice._id){
            return {
              payment_amount: detail.amount,
              payment_title: detail.description
            }
          }
        })
      ];
      payment_details.forEach(e=> total_amount += e.payment_amount);
      const order_code = uuid.v4();
      const soldNotice = new sold_notice_model({
        notice: saled_notice.notice,
        saler_user: saled_notice.notice.saler_user,
        buyer_user: req.decoded.id,
        taken_date: currentTime,
        order_code: order_code,
        cargo_type: saled_notice.notice.payer_of_cargo,
        states: [{
          state_date: currentTime,
          state_type: sold_notice_states.approved
        }],
        contact_informations: address.contact_informations,
        address_informations: address.address_informations,
        payment_details: payment_details,
        payment_total: {
          amount: total_amount,
          payment_type: "kredi kartı"
        }
      });

      await soldNotice.save();
      await user_model.findByIdAndUpdate(saled_notice.notice.saler_user, {
        $addToSet: {sold_notices: soldNotice.id},
        $inc: {sold_notices_count: 1},
      });
      for await(let detail of currentUser.cart.details){
        for await(let coupon of currentUser.user_coupons){
          if(detail.detail_id == coupon._id){
            coupon.is_used_before = true;
            await currentUser.save();
          }
        }
      }
      await currentUser.updateOne({
        $addToSet: {taken_notices: soldNotice._id},});
      await notice_model.findByIdAndUpdate(saled_notice.notice._id,{
        $set: {
          state: notice_states.sold
        }
      });
      
      mailServices.newOrderMail(currentSaler.email,currentNotice.profile_photo,currentSaler.username, currentUser.username,currentNotice.details.brand,total_amount, order_code, currentNotice.payer_of_cargo,`${address.contact_informations.name} ${address.contact_informations.name}`,"http://localhost:3200/render","http://localhost:3200/render");

      mailServices.newTakenNoticeMail(currentUser.email,currentNotice.profile_photo,currentUser.usename,currentNotice.details.brand,total_amount,order_code,currentNotice.payer_of_cargo,`${address.contact_informations.name} ${address.contact_informations.name}`,"http://localhost:3200/render","http://localhost:3200/render");
      timeoutService.soldNoticeToCargo(soldNotice.id);

      if(currentSaler.sold_notices_count == 0){
        const firstSaleNotification= new notificationModel(
          "Tebrikler, ilk siparişini aldın!",
          "Tebrikler, ilk siparişini aldın! Nasıl kargolayacağını öğrenmek için tıkla.",
          notification_types.order,
          new Date(),
          "", 
          );
        socketServices.emitNotificationOneUser(firstSaleNotification, currentSaler.id);
      }
      const salerNotification = new notificationModel(
        "Tebrikler, Yeni bir siparişin var!", 
        "Tebrikler, Yeni bir siparişin var! Sipariş detayları için tıkla.",
        notification_types.order,
        new Date(),
        soldNotice.id, 
      );
      socketServices.emitNotificationOneUser(salerNotification, currentSaler.id);
      
      const buyerNotification = new notificationModel(
        "Siparişin onaylandı!",
        `${currentNotice.details.brand} marka ${currentNotice.details.category.detail_category} ürün siparişin onaylandı. Detayları görmek için tıkla.`,
        notification_types.order,
        new Date(),
        soldNotice.id, 
      );
      socketServices.emitNotificationOneUser(buyerNotification, req.decoded.id);
    }
    await currentUser.updateOne({
      $set: {
        cart: {
          items: [],
          details: [],
        },
        cart_items_count: 0
      },
    });

    return res.send(sendJsonWithTokens(req,"successfuly"));
  } catch (error) {
    console.log(error);
    return next(error);
  }
})

router.post("/cancel_buying", async (req, res, next)=>{
  const sold_notice_id = req.body.sold_notice_id;
  if(!sold_notice_id) return next(new Error("sold notice id cannot be empty"));
  if(!isValidObjectId(sold_notice_id)) return next(new Error("invalid sold notice id"));

  try {
    const sold_notice = await sold_notice_model.findById(sold_notice_id).populate("notice","details.category.detail_category details.brand").populate("buyer_user","username");
    if(!sold_notice) return next(new Error("sold notice not found"));
    if(sold_notice.buyer_user != req.decoded.id) return next(new Error("you cant cancel this saling"));
    if(sold_notice.states[[sold_notice.states.length-1]].state_type != sold_notice_states.approved) return next(new Error("you cant cancel this saling"));

    await sold_notice.updateOne({
      $addToSet: {
        states: {
          state_date: Date.now(),
          state_type: sold_notice_states.canceled,
        }
      }
    });

    await notice_model.findByIdAndUpdate(sold_notice.notice, {
      $set: {
        state: notice_states.takable,
      }
    })

    await user_model.findByIdAndUpdate(req.decoded.id, {
      $pull: {
        taken_notices: sold_notice._id,
      },
    });
    
    await user_model.findByIdAndUpdate(sold_notice.saler_user, {
      $pull: {
        sold_notices: sold_notice_id,
      },
      $inc:{
        sold_notices_count: -1
      }
    });

    const salerNotification = new notificationModel(
      "Alıcı siparişi iptal etti.",
      `@${sold_notice.buyer_user.username} ${sold_notice.notice.details.brand} ${sold_notice.notice.details.category.detail_category} siparişini iptal etti.`,
      notification_types.order,
      new Date(),
      sold_notice.id
    );
    socketServices.emitNotificationOneUser(salerNotification,sold_notice.saler_user);
    return res.send(sendJsonWithTokens(req,"successfuly"));
  } catch (error) {
    return next(error);
  }

})

router.post("/cancel_saling", async (req, res, next)=>{
  const sold_notice_id = req.body.sold_notice_id;
  if(!sold_notice_id) return next(new Error("sold notice id cannot be empty"));
  if(!isValidObjectId(sold_notice_id)) return next(new Error("invalid sold notice id"));

  try {
    const sold_notice = await sold_notice_model.findById(sold_notice_id).populate("saler_user","username").populate("notice","details.category.detail_category details.brand");
    if(!sold_notice) return next(new Error("sold notice not found"));
    if(sold_notice.saler_user != req.decoded.id) return next(new Error("you cant cancel this saling"));
    if(sold_notice.states[[sold_notice.states.length-1]].state_type != sold_notice_states.approved) return next(new Error("you cant cancel this saling"));

    await sold_notice.updateOne({
      $addToSet: {
        states: {
          state_date: Date.now(),
          state_type: sold_notice_states.canceled,
        }
      }
    });

    await notice_model.findByIdAndUpdate(sold_notice.notice, {
      $set: {
        state: notice_states.removedFromSale,
      }
    })

    await user_model.findByIdAndUpdate(sold_notice.buyer_user, {
      $pull: {
        taken_notices: sold_notice._id,
      },
    });
    
    await user_model.findByIdAndUpdate(req.decoded.id, {
      $pull: {
        sold_notices: sold_notice_id,
      },
      $inc:{
        sold_notices_count: -1
      }
    });
    
    const buyerNotification = new notificationModel(
      "Satıcı siparişi iptal etti.",
      `@${sold_notice.saler_user.username} ${sold_notice.notice.details.brand} ${sold_notice.notice.details.category.detail_category} siparişini iptal etti.`,
      notification_types.order,
      new Date(),
      sold_notice.id
    );
    socketServices.emitNotificationOneUser(buyerNotification, sold_notice.buyer_user);
    return res.send(sendJsonWithTokens(req,"successfuly"));
  } catch (error) {
    return next(error);
  }

})

router.get("/get_order_info_buyer", async (req, res, next)=>{
  const sold_notice_id = req.body.sold_notice_id;
  if(!sold_notice_id) return next(new Error("sold notice id cannot be empty"));
  if(!isValidObjectId(sold_notice_id)) return next(new Error("invalid sold notice id"));

  try {
    const order = await sold_notice_model.findById(sold_notice_id).populate("notice", "details.category.detail_category details.use_case details.size profile_photo price_details.initial_price").populate("saler_user","username");

    if(!order) return next(new Error("order not found"));
    return res.send(sendJsonWithTokens(req,order));

  } catch (error) {
    console.log(error);
    return next(error);
  }

})

router.get("/get_order_info_saler", async (req, res, next)=>{
  const sold_notice_id = req.body.sold_notice_id;
  if(!sold_notice_id) return next(new Error("sold notice id cannot be empty"));
  if(!isValidObjectId(sold_notice_id)) return next(new Error("invalid sold notice id"));

  try {
    const order = await sold_notice_model.findById(sold_notice_id).populate("notice", "details.category.detail_category details.use_case details.size profile_photo price_details.initial_price").populate("buyer_user","username");

    if(!order) return next(new Error("order not found"));
    return res.send(sendJsonWithTokens(req,order));

  } catch (error) {
    console.log(error);
    return next(error);
  }

})

module.exports = router;